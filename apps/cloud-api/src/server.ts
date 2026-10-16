import Fastify, {type FastifyRequest} from 'fastify';
import cookie from '@fastify/cookie';
import argon2 from 'argon2';
import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {Bootstrap,SyncEnvelope,CommandKind,CommandResult,REPLICATED_TABLES,type RecordChange} from '@forkflow/contracts';
import {ProductUpdate,CategoryUpdate,VariantUpdate} from '@forkflow/domain/catalog-schemas';
import {SettingsUpdate} from '@forkflow/domain/settings-schemas';
import {FEATURES} from '@forkflow/domain/features';
import {StaffOverrides} from '@forkflow/domain/staff-permissions';
import {ApiError,transaction,hash,token,canonical} from './db.js';
import {salesReport,operationalReport} from './reports.js';
import {retainedBackupIds,type ObjectStorage} from './storage.js';

export interface CloudOptions {
 hostedPosEmail?:string;
 pool:Pool; portalOrigin:string; secureCookies?:boolean; now?:()=>number;
 mailer:{deliver(message:{email:string;token:string;kind:'invite'|'reset';expiresAt:number}):Promise<void>};
 subscriptionBridge?:{create(installationId:string,plan:'basic'|'pro',period:'monthly'|'yearly'):Promise<{url:string}>};
 storage?:ObjectStorage;
}
interface Account {id:string;email:string;platform_role:'owner'|'platform_admin';csrf_hash:string}
interface Outlet {id:string;organization_id:string;name:string;installation_id:string|null;epoch:string|null;acknowledged_sequence:string;bootstrapped:boolean;bootstrap_hash:string|null;last_seen_at:string|null}
const UUID=z.string().uuid(), Email=z.string().trim().toLowerCase().email().max(254), Password=z.string().min(12).max(256), Name=z.string().trim().min(1).max(160);
const parse=<T>(schema:z.ZodType<T>,value:unknown):T=>{const result=schema.safeParse(value);if(!result.success)throw new ApiError(400,'Invalid request');return result.data;};
const outletJson=(outlet:Outlet)=>({id:outlet.id,organizationId:outlet.organization_id,name:outlet.name,installationId:outlet.installation_id,epoch:outlet.epoch,lastSeenAt:outlet.last_seen_at===null?null:Number(outlet.last_seen_at),acknowledgedSequence:Number(outlet.acknowledged_sequence),initialSyncComplete:outlet.bootstrapped});
const commandJson=(row:Record<string,any>)=>({id:row.id,kind:row.kind,...(row.target_id?{targetId:row.target_id}:{}),expectedRevision:Number(row.expected_revision),payload:row.payload,requestedBy:row.requested_by,createdAt:Number(row.created_at),status:row.status,...(row.revision===null?{}:{revision:Number(row.revision)}),...(row.error?{error:row.error}:{})});
export async function createCloudApi(options:CloudOptions) {
 const {pool}=options,now=options.now??Date.now;
 const app=Fastify({bodyLimit:64*1024*1024,logger:false,trustProxy:false});
 await app.register(cookie);
 const accounts=new WeakMap<FastifyRequest,Account>();
 const sessions=new WeakMap<FastifyRequest,string>();
 const rates=new Map<string,{count:number;until:number}>();
 const publicPaths=new Set(['/v1/auth/login','/v1/auth/invite/consume','/v1/auth/reset/request','/v1/auth/reset/consume','/v1/outlets/pair','/health']);
 app.setErrorHandler((error,_request,reply)=>{
  const known=error instanceof ApiError;const status=known?error.statusCode:((error as {statusCode?:number}).statusCode===413?413:500);
  reply.code(status).send({error:known?error.message:status===413?'Payload too large':'Internal server error'});
 });
 app.addHook('onRequest',async(request,reply)=>{
  reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff');
  const path=request.url.split('?')[0]!;
  if(publicPaths.has(path) && request.method==='POST'){
   const origin=request.headers.origin;if(origin && origin!==options.portalOrigin)throw new ApiError(403,'Origin rejected');
   const key=`${request.ip}:${path}`,entry=rates.get(key),time=now();
   if(!entry||entry.until<=time){if(rates.size>10000)rates.clear();rates.set(key,{count:1,until:time+60000});}
   else if(++entry.count>20)throw new ApiError(429,'Too many requests');
  }
  if(publicPaths.has(path)||path.startsWith('/v1/sync/')||path.startsWith('/v1/storage/'))return;
  const raw=request.cookies['__Host-forkflow_session']??request.cookies['forkflow_session'];
  if(!raw||!/^[A-Za-z0-9_-]{43}$/.test(raw))throw new ApiError(401,'Sign in required');
  const row=(await pool.query('SELECT a.id,a.email,a.platform_role,s.csrf_hash FROM web_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>$2 AND NOT a.disabled',[hash(raw),now()])).rows[0] as Account|undefined;
  if(!row)throw new ApiError(401,'Sign in required');accounts.set(request,row);sessions.set(request,raw);
  if(!['GET','HEAD'].includes(request.method)&&(request.headers.origin!==options.portalOrigin||typeof request.headers['x-csrf-token']!=='string'||hash(request.headers['x-csrf-token'])!==row.csrf_hash))throw new ApiError(403,'Origin and CSRF token required');
 });
 const account=(request:FastifyRequest)=>{const value=accounts.get(request);if(!value)throw new ApiError(401,'Sign in required');return value;};
 const operator=(request:FastifyRequest)=>{const value=account(request);if(value.platform_role!=='platform_admin')throw new ApiError(403,'Platform operator required');return value;};
 const membership=async(accountId:string,organizationId:string,write=false,owner=false)=>{
  const row=(await pool.query('SELECT role FROM memberships WHERE account_id=$1 AND organization_id=$2',[accountId,organizationId])).rows[0];
  if(!row)throw new ApiError(404,'Organization not found');if(owner&&row.role!=='owner'||write&&row.role==='viewer')throw new ApiError(403,'Insufficient organization permission');return row.role as string;
 };
 const withOutlet=async<T>(request:FastifyRequest,write:boolean,owner:boolean,operation:(client:PoolClient,outlet:Outlet)=>Promise<T>)=>{
  const id=parse(UUID,(request.params as {id:string}).id),user=account(request);
  const scopes=(await pool.query('SELECT organization_id,role FROM memberships WHERE account_id=$1',[user.id])).rows;
  for(const scope of scopes){const result=await transaction(pool,scope.organization_id,async client=>{
   const outlet=(await client.query('SELECT * FROM outlets WHERE id=$1'+(write?' FOR UPDATE':''),[id])).rows[0] as Outlet|undefined;
   if(!outlet)return undefined;if(owner&&scope.role!=='owner'||write&&scope.role==='viewer')throw new ApiError(403,'Insufficient organization permission');return{value:await operation(client,outlet)};
  });if(result)return result.value;}
  throw new ApiError(404,'Outlet not found');
 };
 const audit=async(client:PoolClient,organizationId:string,actorId:string|null,action:string,targetId:string,details:unknown={})=>{await client.query('INSERT INTO audit_log(id,organization_id,actor_id,action,target_id,details,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),organizationId,actorId,action,targetId,details,now()]);};
 const invite=async(client:PoolClient,email:string,organizationId:string,role:string)=>{
  const existing=(await client.query('SELECT id,password_hash FROM accounts WHERE email=$1 FOR UPDATE',[email])).rows[0];
  const id=existing?.id??randomUUID();if(!existing)await client.query('INSERT INTO accounts(id,email,created_at) VALUES($1,$2,$3)',[id,email,now()]);
  await client.query('INSERT INTO memberships(organization_id,account_id,role) VALUES($1,$2,$3) ON CONFLICT(organization_id,account_id) DO UPDATE SET role=EXCLUDED.role',[organizationId,id,role]);
  const raw=token(),expiresAt=now()+24*60*60*1000;
  await client.query("DELETE FROM account_tokens WHERE account_id=$1 AND kind='invite'",[id]);
  await client.query("INSERT INTO account_tokens(token_hash,account_id,kind,expires_at,created_at) VALUES($1,$2,'invite',$3,$4)",[hash(raw),id,expiresAt,now()]);return{email,token:raw,kind:'invite' as const,expiresAt};
 };
 app.get('/health',async()=>{await pool.query('SELECT 1');return{ok:true,service:'forkflow-cloud',protocolVersion:1};});
 app.get('/v1/auth/pos-access',async(request,reply)=>{
  const user=account(request);
  if(!options.hostedPosEmail||user.email!==options.hostedPosEmail.trim().toLowerCase())throw new ApiError(403,'This account cannot access the hosted restaurant');
  return reply.code(204).send();
 });
 app.post('/v1/auth/login',async(request,reply)=>{
  const input=parse(z.object({email:Email,password:z.string().min(1).max(256)}).strict(),request.body);
  const found=(await pool.query('SELECT * FROM accounts WHERE email=$1 AND NOT disabled',[input.email])).rows[0];
  if(!found?.password_hash||!await argon2.verify(found.password_hash,input.password))throw new ApiError(401,'Incorrect email or password');
  const raw=token(),csrfToken=hash(`csrf:${raw}`),expiresAt=now()+12*60*60*1000;
  await pool.query('INSERT INTO web_sessions(token_hash,account_id,csrf_hash,expires_at,created_at) VALUES($1,$2,$3,$4,$5)',[hash(raw),found.id,hash(csrfToken),expiresAt,now()]);
  reply.setCookie(options.secureCookies===false?'forkflow_session':'__Host-forkflow_session',raw,{httpOnly:true,secure:options.secureCookies!==false,sameSite:'strict',path:'/',maxAge:12*60*60});
  const memberships=(await pool.query('SELECT m.organization_id AS "organizationId",o.name,m.role FROM memberships m JOIN organizations o ON o.id=m.organization_id WHERE m.account_id=$1 ORDER BY o.name',[found.id])).rows;
  return{user:{id:found.id,email:found.email,platformRole:found.platform_role},csrfToken,memberships};
 });
 app.get('/v1/auth/me',async request=>{const user=account(request);return{user:{id:user.id,email:user.email,platformRole:user.platform_role},csrfToken:hash(`csrf:${sessions.get(request)}`),memberships:(await pool.query('SELECT m.organization_id AS "organizationId",o.name,m.role FROM memberships m JOIN organizations o ON o.id=m.organization_id WHERE m.account_id=$1 ORDER BY o.name',[user.id])).rows};});
 app.post('/v1/auth/logout',async(request,reply)=>{await pool.query('DELETE FROM web_sessions WHERE token_hash=$1',[hash(sessions.get(request)!)]);reply.clearCookie(options.secureCookies===false?'forkflow_session':'__Host-forkflow_session',{path:'/',secure:options.secureCookies!==false,httpOnly:true,sameSite:'strict'});return{accepted:true};});
 app.post('/v1/auth/reset/request',async(request,reply)=>{
  const input=parse(z.object({email:Email}).strict(),request.body);const message=await transaction(pool,null,async client=>{
   const found=(await client.query('SELECT id FROM accounts WHERE email=$1 AND NOT disabled FOR UPDATE',[input.email])).rows[0];if(!found)return null;
   const raw=token(),expiresAt=now()+30*60000;await client.query("DELETE FROM account_tokens WHERE account_id=$1 AND kind='reset'",[found.id]);await client.query("INSERT INTO account_tokens(token_hash,account_id,kind,expires_at,created_at) VALUES($1,$2,'reset',$3,$4)",[hash(raw),found.id,expiresAt,now()]);return{email:input.email,token:raw,kind:'reset' as const,expiresAt};
  });if(message)await options.mailer.deliver(message);reply.code(202);return{accepted:true};
 });
 for(const kind of ['invite','reset'] as const)app.post(`/v1/auth/${kind}/consume`,async request=>{
  const input=parse(z.object({token:z.string().regex(/^[A-Za-z0-9_-]{43}$/),password:Password}).strict(),request.body);
  const password=await argon2.hash(input.password,{type:argon2.argon2id,memoryCost:19456,timeCost:2,parallelism:1});
  await transaction(pool,null,async client=>{
   const found=(await client.query('DELETE FROM account_tokens WHERE token_hash=$1 AND kind=$2 AND expires_at>$3 RETURNING account_id',[hash(input.token),kind,now()])).rows[0];if(!found)throw new ApiError(400,'Link expired or already used');
   // Inviting an existing account grants membership but does not reset its established password.
   if(kind==='invite')await client.query('UPDATE accounts SET password_hash=COALESCE(password_hash,$1) WHERE id=$2 AND NOT disabled',[password,found.account_id]);
   else await client.query('UPDATE accounts SET password_hash=$1 WHERE id=$2 AND NOT disabled',[password,found.account_id]);
   await client.query('DELETE FROM web_sessions WHERE account_id=$1',[found.account_id]);await client.query('DELETE FROM account_tokens WHERE account_id=$1',[found.account_id]);
  });return{accepted:true};
 });
 app.get('/v1/organizations',async request=>({organizations:(await pool.query('SELECT o.id,o.name,m.role FROM organizations o JOIN memberships m ON m.organization_id=o.id WHERE m.account_id=$1 ORDER BY o.name',[account(request).id])).rows}));
 app.get('/v1/platform/organizations',async request=>{operator(request);return{organizations:(await pool.query('SELECT o.id,o.name,(SELECT count(*)::int FROM memberships m WHERE m.organization_id=o.id) AS "memberCount" FROM organizations o ORDER BY o.name')).rows.map(row=>({...row,outletCount:null}))};});
 app.post('/v1/platform/organizations',async(request,reply)=>{
  const actor=operator(request),input=parse(z.object({name:Name,email:Email}).strict(),request.body),id=randomUUID();
  const message=await transaction(pool,id,async client=>{await client.query('INSERT INTO organizations(id,name,created_at) VALUES($1,$2,$3)',[id,input.name,now()]);const message=await invite(client,input.email,id,'owner');await audit(client,id,actor.id,'organization.created',id);return message;});
  await options.mailer.deliver(message);reply.code(201);return{organization:{id,name:input.name},expiresAt:message.expiresAt};
 });
 app.post('/v1/platform/invitations',async(request,reply)=>{
  const actor=operator(request),input=parse(z.object({organizationId:UUID,email:Email,role:z.enum(['owner','manager','viewer'])}).strict(),request.body);
  const message=await transaction(pool,input.organizationId,async client=>{if(!(await client.query('SELECT 1 FROM organizations WHERE id=$1',[input.organizationId])).rowCount)throw new ApiError(404,'Organization not found');const message=await invite(client,input.email,input.organizationId,input.role);await audit(client,input.organizationId,actor.id,'member.invited',input.email,{role:input.role});return message;});
  await options.mailer.deliver(message);reply.code(202);return{expiresAt:message.expiresAt};
 });
 app.get('/v1/outlets',async request=>{
  const user=account(request),scopes=(await pool.query('SELECT organization_id FROM memberships WHERE account_id=$1',[user.id])).rows,outlets=[];
  for(const scope of scopes){const rows=await transaction(pool,scope.organization_id,async client=>(await client.query('SELECT * FROM outlets ORDER BY name')).rows);outlets.push(...rows.map(outletJson));}return{outlets};
 });
 app.post('/v1/outlets',async(request,reply)=>{
  const input=parse(z.object({organizationId:UUID,name:Name}).strict(),request.body),user=account(request);await membership(user.id,input.organizationId,true,true);
  const outlet=await transaction(pool,input.organizationId,async client=>{const row=(await client.query('INSERT INTO outlets(id,organization_id,name,created_at) VALUES($1,$2,$3,$4) RETURNING *',[randomUUID(),input.organizationId,input.name,now()])).rows[0];await audit(client,input.organizationId,user.id,'outlet.created',row.id);return row;});reply.code(201);return{outlet:outletJson(outlet)};
 });
 app.get('/v1/outlets/:id/status',request=>withOutlet(request,false,false,async(client,outlet)=>({...outletJson(outlet),pendingCommands:Number((await client.query("SELECT count(*) FROM management_commands WHERE outlet_id=$1 AND status='pending'",[outlet.id])).rows[0].count),subscription:(await client.query('SELECT state FROM subscriptions WHERE outlet_id=$1',[outlet.id])).rows[0]?.state??null,outstandingUploads:null})));
 app.post('/v1/outlets/:id/pairing',request=>withOutlet(request,true,true,async(client,outlet)=>{
  if(outlet.installation_id)throw new ApiError(409,'Revoke the active installation before pairing');const raw=token(),expiresAt=now()+10*60000;
  await client.query('DELETE FROM pairing_codes WHERE outlet_id=$1',[outlet.id]);await client.query('INSERT INTO pairing_codes(code_hash,organization_id,outlet_id,expires_at) VALUES($1,$2,$3,$4)',[hash(raw),outlet.organization_id,outlet.id,expiresAt]);await audit(client,outlet.organization_id,account(request).id,'pairing.created',outlet.id);return{code:raw,expiresAt};
 }));
 app.post('/v1/outlets/pair',async request=>{
  const input=parse(z.object({code:z.string().min(20).max(100),installationId:UUID}).strict(),request.body);
  return transaction(pool,null,async client=>{
   const found=(await client.query('SELECT * FROM pairing_codes WHERE code_hash=$1 AND expires_at>$2 FOR UPDATE',[hash(input.code),now()])).rows[0];if(!found)throw new ApiError(401,'Invalid or expired pairing code');
   await client.query("SELECT set_config('app.organization_id',$1,true)",[found.organization_id]);const outlet=(await client.query('SELECT * FROM outlets WHERE id=$1 FOR UPDATE',[found.outlet_id])).rows[0] as Outlet;
   if(outlet.installation_id)throw new ApiError(409,'Outlet already paired');
   const credential=token(),epoch=randomUUID();await client.query('DELETE FROM pairing_codes WHERE outlet_id=$1',[outlet.id]);
   try{await client.query('UPDATE outlets SET installation_id=$1,epoch=$2,acknowledged_sequence=0,bootstrapped=false,bootstrap_hash=NULL,last_seen_at=$3 WHERE id=$4',[input.installationId,epoch,now(),outlet.id]);}catch(error){if((error as {code?:string}).code==='23505')throw new ApiError(409,'Installation already paired');throw error;}
   await client.query('INSERT INTO installation_credentials(credential_hash,organization_id,outlet_id,installation_id) VALUES($1,$2,$3,$4)',[hash(credential),found.organization_id,outlet.id,input.installationId]);await audit(client,found.organization_id,null,'installation.paired',outlet.id,{installationId:input.installationId});return{outletId:outlet.id,installationId:input.installationId,credential,epoch};
  });
 });
 app.post('/v1/outlets/:id/revoke',request=>withOutlet(request,true,true,async(client,outlet)=>{await client.query('UPDATE installation_credentials SET revoked=true WHERE outlet_id=$1',[outlet.id]);await client.query('DELETE FROM pairing_codes WHERE outlet_id=$1',[outlet.id]);await client.query('UPDATE outlets SET installation_id=NULL,last_seen_at=NULL WHERE id=$1',[outlet.id]);await client.query("UPDATE management_commands SET status='cancelled',completed_at=$1 WHERE outlet_id=$2 AND status='pending'",[now(),outlet.id]);await audit(client,outlet.organization_id,account(request).id,'installation.revoked',outlet.id);return{revoked:true};}));
 const installation=async<T>(request:FastifyRequest,operation:(client:PoolClient,outlet:Outlet)=>Promise<T>)=>{
  const authorization=request.headers.authorization;if(!authorization?.startsWith('Bearer '))throw new ApiError(401,'Installation credential required');
  const raw=authorization.slice(7);if(!/^[A-Za-z0-9_-]{43}$/.test(raw))throw new ApiError(401,'Invalid installation credential');
  const found=(await pool.query('SELECT * FROM installation_credentials WHERE credential_hash=$1 AND NOT revoked',[hash(raw)])).rows[0];if(!found)throw new ApiError(401,'Installation credential revoked or invalid');
  return transaction(pool,found.organization_id,async client=>{
   const outlet=(await client.query('SELECT * FROM outlets WHERE id=$1 FOR UPDATE',[found.outlet_id])).rows[0] as Outlet|undefined;
   // Recheck after locking to close the revocation race.
   if(!outlet||outlet.installation_id!==found.installation_id||!(await client.query('SELECT 1 FROM installation_credentials WHERE credential_hash=$1 AND NOT revoked',[hash(raw)])).rowCount)throw new ApiError(401,'Installation credential revoked or invalid');
   await client.query('UPDATE outlets SET last_seen_at=$1 WHERE id=$2',[now(),outlet.id]);return operation(client,outlet);
  });
 };
 const assertSource=(outlet:Outlet,source:{outletId:string;installationId:string;epoch:string})=>{if(source.outletId!==outlet.id||source.installationId!==outlet.installation_id||source.epoch!==outlet.epoch)throw new ApiError(409,'Installation or epoch mismatch');};
 const project=async(client:PoolClient,outlet:Outlet,changes:RecordChange[],sequence:number,bootstrap=false)=>{
  for(const change of changes){const revision=bootstrap?(change.revision??sequence):sequence;if(revision>sequence)throw new ApiError(400,'Record revision exceeds snapshot cursor');
   if(change.row===null)await client.query('DELETE FROM projections WHERE outlet_id=$1 AND entity_table=$2 AND entity_key=$3',[outlet.id,change.table,change.key]);
   else await client.query('INSERT INTO projections(organization_id,outlet_id,entity_table,entity_key,row_data,revision) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(outlet_id,entity_table,entity_key) DO UPDATE SET row_data=EXCLUDED.row_data,revision=EXCLUDED.revision',[outlet.organization_id,outlet.id,change.table,change.key,change.row,revision]);
  }
 };
 app.post('/v1/sync/bootstrap',request=>installation(request,async(client,outlet)=>{
  const input=parse(Bootstrap,request.body);assertSource(outlet,input);const digest=hash(canonical(input));
  if(outlet.bootstrapped){if(outlet.bootstrap_hash!==digest)throw new ApiError(409,'Snapshot already committed');return{acknowledgedSequence:Number(outlet.acknowledged_sequence)};}
  const keys=new Set<string>();for(const record of input.records){const key=record.table+canonical(record.key);if(keys.has(key))throw new ApiError(400,'Duplicate snapshot identity');keys.add(key);}
  await client.query('DELETE FROM projections WHERE outlet_id=$1',[outlet.id]);await project(client,outlet,input.records,input.sequence,true);
  await client.query('UPDATE outlets SET bootstrapped=true,bootstrap_hash=$1,acknowledged_sequence=$2 WHERE id=$3',[digest,input.sequence,outlet.id]);return{acknowledgedSequence:input.sequence};
 }));
 app.post('/v1/sync/push',request=>installation(request,async(client,outlet)=>{
  const input=parse(z.object({events:z.array(SyncEnvelope).min(1).max(500)}).strict(),request.body);if(!outlet.bootstrapped)throw new ApiError(409,'Bootstrap required');let cursor=Number(outlet.acknowledged_sequence);
  for(const event of input.events){assertSource(outlet,event);parse(UUID,event.eventId);const digest=hash(canonical(event));
   if(event.sequence<=cursor){const previous=(await client.query('SELECT digest FROM sync_journal WHERE outlet_id=$1 AND epoch=$2 AND sequence=$3',[outlet.id,outlet.epoch,event.sequence])).rows[0];if(previous?.digest!==digest)throw new ApiError(409,'Conflicting event replay');continue;}
   if(event.sequence!==cursor+1)throw new ApiError(409,'Missing sync sequence');
   if((await client.query('SELECT 1 FROM sync_journal WHERE outlet_id=$1 AND event_id=$2',[outlet.id,event.eventId])).rowCount)throw new ApiError(409,'Event ID reused');
   await client.query('INSERT INTO sync_journal(organization_id,outlet_id,epoch,sequence,event_id,digest,envelope,received_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[outlet.organization_id,outlet.id,outlet.epoch,event.sequence,event.eventId,digest,event,now()]);await project(client,outlet,event.changes,event.sequence);cursor=event.sequence;
  }await client.query('UPDATE outlets SET acknowledged_sequence=$1 WHERE id=$2',[cursor,outlet.id]);return{acknowledgedSequence:cursor};
 }));
 app.get('/v1/sync/commands',request=>installation(request,async(client,outlet)=>({commands:(await client.query("SELECT * FROM management_commands WHERE outlet_id=$1 AND status='pending' ORDER BY created_at,id LIMIT 100",[outlet.id])).rows.map(({status:_,...row})=>{const mapped=commandJson({...row,status:'pending'});const {status,...command}=mapped;return command;})})));
 app.post('/v1/sync/commands',request=>installation(request,async(client,outlet)=>{
  const {results}=parse(z.object({results:z.array(CommandResult).max(100)}).strict(),request.body);
  for(const result of results){parse(UUID,result.id);const command=(await client.query('SELECT * FROM management_commands WHERE id=$1 AND outlet_id=$2 FOR UPDATE',[result.id,outlet.id])).rows[0];if(!command)throw new ApiError(404,'Command not found');
   if(command.status!=='pending'){if(command.status!==result.status||Number(command.revision??-1)!==(result.revision??-1)||(command.error??undefined)!==result.error)throw new ApiError(409,'Command result already recorded');continue;}
   await client.query('UPDATE management_commands SET status=$1,revision=$2,error=$3,completed_at=$4 WHERE id=$5',[result.status,result.revision??null,result.error??null,now(),result.id]);
  }return{accepted:true};
 }));
 app.get('/v1/outlets/:id/records',request=>withOutlet(request,false,false,async(client,outlet)=>{
  const input=parse(z.object({table:z.enum(REPLICATED_TABLES),limit:z.coerce.number().int().min(1).max(500).default(200),cursor:z.string().max(4000).optional()}).strict(),request.query);
  let cursor:Record<string,unknown>|null=null;if(input.cursor){try{cursor=JSON.parse(Buffer.from(input.cursor,'base64url').toString());}catch{throw new ApiError(400,'Invalid cursor');}}
  const rows=(await client.query('SELECT entity_key,row_data,revision FROM projections WHERE outlet_id=$1 AND entity_table=$2 AND ($3::jsonb IS NULL OR entity_key>$3::jsonb) ORDER BY entity_key LIMIT $4',[outlet.id,input.table,cursor,input.limit+1])).rows;
  const page=rows.slice(0,input.limit);return{records:page.map(row=>({key:row.entity_key,row:row.row_data,revision:Number(row.revision)})),nextCursor:rows.length>input.limit?Buffer.from(JSON.stringify(page.at(-1)!.entity_key)).toString('base64url'):null,lastSeenAt:outletJson(outlet).lastSeenAt,acknowledgedSequence:Number(outlet.acknowledged_sequence)};
 }));
 app.get('/v1/outlets/:id/reports',request=>withOutlet(request,false,false,async(client,outlet)=>({...await salesReport(client,outlet.id,request.query),lastSeenAt:outletJson(outlet).lastSeenAt,acknowledgedSequence:Number(outlet.acknowledged_sequence)})));
 app.get('/v1/outlets/:id/reports/operations/:kind',request=>withOutlet(request,false,false,async(client,outlet)=>({report:await operationalReport(client,outlet.id,(request.params as {kind:string}).kind,request.query,now()),lastSeenAt:outletJson(outlet).lastSeenAt,acknowledgedSequence:Number(outlet.acknowledged_sequence)})));
 app.get('/v1/outlets/:id/commands',request=>withOutlet(request,false,false,async(client,outlet)=>({commands:(await client.query('SELECT * FROM management_commands WHERE outlet_id=$1 ORDER BY created_at DESC,id DESC LIMIT 200',[outlet.id])).rows.map(commandJson)})));
 app.post('/v1/outlets/:id/commands',async(request,reply)=>{
  const result=await withOutlet(request,true,false,async(client,outlet)=>{
   const input=parse(z.object({kind:CommandKind,targetId:z.string().min(1).max(200),expectedRevision:z.number().int().nonnegative().safe(),payload:z.record(z.string(),z.unknown())}).strict(),request.body);
   const schemas={'settings.update':SettingsUpdate.strict(),'product.update':ProductUpdate.omit({photo:true}).strict(),'category.update':CategoryUpdate.strict(),'variant.update':VariantUpdate.strict(),'features.update':z.object({enabled:z.record(z.string(),z.boolean()).refine(values=>Object.keys(values).every(id=>FEATURES.some(f=>f.id===id&&f.configurable)))}).strict(),'staff.update':z.object({overrides:StaffOverrides}).strict()};
   const payload=parse(schemas[input.kind] as z.ZodType<Record<string,unknown>>,input.payload);if(Object.keys(payload).length===0)throw new ApiError(400,'Empty command');
   if(input.kind==='features.update'||input.kind==='staff.update')await membership(account(request).id,outlet.organization_id,true,true);
   if(input.kind==='settings.update'&&input.targetId!=='1'||input.kind==='features.update'&&input.targetId!=='policy')throw new ApiError(400,'Invalid command target');
   if(['product.update','category.update','variant.update','staff.update'].includes(input.kind))parse(UUID,input.targetId);
   const table={'settings.update':'settings','product.update':'products','category.update':'categories','variant.update':'variants','features.update':'cloud_feature_policy','staff.update':'cloud_staff_policy'}[input.kind];
   const projection=(await client.query("SELECT revision FROM projections WHERE outlet_id=$1 AND entity_table=$2 AND (entity_key->>'id'=$3 OR entity_key->>'key'=$3 OR entity_key->>'user_id'=$3)",[outlet.id,table,input.targetId])).rows[0];
   if(!projection&&['product.update','category.update','variant.update','settings.update'].includes(input.kind))throw new ApiError(404,'Target not found');
   const revision=Number(projection?.revision??0);if(revision!==input.expectedRevision)throw new ApiError(409,'Target revision changed; refresh before retrying');
   const row=(await client.query('INSERT INTO management_commands(id,organization_id,outlet_id,kind,target_id,expected_revision,payload,requested_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[randomUUID(),outlet.organization_id,outlet.id,input.kind,input.targetId,input.expectedRevision,payload,account(request).id,now()])).rows[0];await audit(client,outlet.organization_id,account(request).id,'command.created',row.id,{kind:input.kind,targetId:input.targetId});return{command:commandJson(row)};
  });reply.code(201);return result;
 });
 app.post('/v1/outlets/:id/commands/:commandId/cancel',request=>withOutlet(request,true,false,async(client,outlet)=>{
  const id=parse(UUID,(request.params as {commandId:string}).commandId);const row=(await client.query("UPDATE management_commands SET status='cancelled',completed_at=$1 WHERE id=$2 AND outlet_id=$3 AND status='pending' RETURNING *",[now(),id,outlet.id])).rows[0];if(!row)throw new ApiError(409,'Command already completed or not found');await audit(client,outlet.organization_id,account(request).id,'command.cancelled',id);return{command:commandJson(row)};
 }));
 app.post('/v1/outlets/:id/subscription',request=>withOutlet(request,true,true,async(_client,outlet)=>{
  const input=parse(z.object({plan:z.enum(['basic','pro']),period:z.enum(['monthly','yearly'])}).strict(),request.body);if(!outlet.installation_id)throw new ApiError(409,'Pair an installation first');if(!options.subscriptionBridge)throw new ApiError(503,'Subscription service unavailable');return options.subscriptionBridge.create(outlet.installation_id,input.plan,input.period);
 }));
 app.get('/v1/sync/journal',request=>installation(request,async(client,outlet)=>{
  const input=parse(z.object({after:z.coerce.number().int().nonnegative().safe().default(0),limit:z.coerce.number().int().min(1).max(500).default(100)}).strict(),request.query);
  const rows=(await client.query('SELECT envelope FROM sync_journal WHERE outlet_id=$1 AND epoch=$2 AND sequence>$3 ORDER BY sequence LIMIT $4',[outlet.id,outlet.epoch,input.after,input.limit])).rows;
  return{events:rows.map(row=>row.envelope),highWatermark:Number(outlet.acknowledged_sequence)};
 }));
 const storage=()=>{if(!options.storage)throw new ApiError(503,'Object storage unavailable');return options.storage;};
 const digest=z.string().regex(/^[a-f0-9]{64}$/);
 const BackupMetadata=z.object({id:UUID,format:z.literal('ffbk1'),outletId:UUID,installationId:UUID,epoch:UUID,sequence:z.number().int().nonnegative().safe(),createdAt:z.number().int().nonnegative().safe(),keyId:digest,sha256:digest,bytes:z.number().int().positive().max(2*1024*1024*1024)}).strict();
 const MediaMetadata=z.object({productId:UUID,photoHash:digest}).strict();
 const storageInput=(body:unknown,outlet:Outlet)=>{
  const input=parse(z.object({kind:z.enum(['backup','media']),objectId:UUID,sha256:digest,bytes:z.number().int().positive().max(2*1024*1024*1024),metadata:z.unknown()}).strict(),body);
  if(input.kind==='backup'){
   const meta=parse(BackupMetadata,input.metadata);
   if(meta.id!==input.objectId||meta.sha256!==input.sha256||meta.bytes!==input.bytes||meta.outletId!==outlet.id||meta.installationId!==outlet.installation_id||meta.epoch!==outlet.epoch||meta.createdAt>now()+300000)throw new ApiError(400,'Backup manifest identity or integrity mismatch');
   return{...input,metadata:meta};
  }
  const meta=parse(MediaMetadata,input.metadata);if(meta.photoHash!==input.sha256||input.bytes>20*1024*1024)throw new ApiError(400,'Invalid media manifest');return{...input,metadata:meta};
 };
 app.post('/v1/storage/upload',request=>installation(request,async(client,outlet)=>{
  const input=storageInput(request.body,outlet),store=storage();
  const existing=(await client.query('SELECT * FROM storage_objects WHERE id=$1 AND outlet_id=$2 FOR UPDATE',[input.objectId,outlet.id])).rows[0];
  if(existing&&(existing.kind!==input.kind||existing.sha256!==input.sha256||Number(existing.bytes)!==input.bytes||canonical(existing.metadata)!==canonical(input.metadata)))throw new ApiError(409,'Object ID already has a different manifest');
  if(existing?.state==='deleted')throw new ApiError(409,'Backup expired by retention');
  const prefix=`organizations/${outlet.organization_id}/outlets/${outlet.id}/${input.kind}`,objectKey=`${prefix}/${input.objectId}/${input.sha256}`;
  // Presigned writers can only overwrite staging. Completed objects have a different key and are copied by the server.
  const stagingKey=existing?.staging_key??`${prefix}/staging/${input.objectId}/${input.sha256}`;
  await client.query("INSERT INTO storage_objects(id,organization_id,outlet_id,installation_id,kind,sha256,bytes,metadata,staging_key,object_key,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO UPDATE SET expires_at=EXCLUDED.expires_at",[input.objectId,outlet.organization_id,outlet.id,outlet.installation_id,input.kind,input.sha256,input.bytes,input.metadata,stagingKey,objectKey,now(),now()+24*3600000]);
  return{...await store.upload(stagingKey,input.bytes,input.sha256),objectKey};
 }));
 app.post('/v1/storage/complete',request=>installation(request,async(client,outlet)=>{
  const input=storageInput(request.body,outlet),store=storage(),row=(await client.query('SELECT * FROM storage_objects WHERE id=$1 AND outlet_id=$2 FOR UPDATE',[input.objectId,outlet.id])).rows[0];
  if(!row||row.kind!==input.kind||row.sha256!==input.sha256||Number(row.bytes)!==input.bytes||canonical(row.metadata)!==canonical(input.metadata))throw new ApiError(409,'Upload ticket manifest mismatch');
  if(row.state==='complete')return{accepted:true,objectKey:row.object_key};if(row.state==='deleted'||Number(row.expires_at)<now())throw new ApiError(409,'Upload ticket expired');
  const verified=await store.verify(row.staging_key,input.bytes,input.sha256);await store.promote(row.staging_key,row.object_key,verified.etag);
  await client.query("UPDATE storage_objects SET state='complete',completed_at=$1 WHERE id=$2",[now(),input.objectId]);
  await audit(client,outlet.organization_id,null,'storage.completed',input.objectId,{kind:input.kind,sha256:input.sha256,bytes:input.bytes});
  if(input.kind==='backup'){
   const backups=(await client.query("SELECT id,object_key,staging_key,metadata FROM storage_objects WHERE outlet_id=$1 AND kind='backup' AND state='complete' ORDER BY completed_at DESC",[outlet.id])).rows;
   const retained=retainedBackupIds(backups.map(row=>({id:row.id,createdAt:Number(row.metadata.createdAt)})),now());
   for(const backup of backups)if(!retained.has(backup.id)){await store.remove(backup.object_key);await store.remove(backup.staging_key);await client.query("UPDATE storage_objects SET state='deleted' WHERE id=$1",[backup.id]);}
  }
  await store.remove(row.staging_key);return{accepted:true,objectKey:row.object_key};
 }));
 const backups=async(client:PoolClient,outlet:Outlet)=>({backups:(await client.query("SELECT metadata FROM storage_objects WHERE outlet_id=$1 AND kind='backup' AND state='complete' ORDER BY (metadata->>'createdAt')::bigint DESC,id DESC",[outlet.id])).rows.map(row=>row.metadata)});
 const backupDownload=async(client:PoolClient,outlet:Outlet,id:unknown)=>{
  const row=(await client.query("SELECT object_key,metadata FROM storage_objects WHERE id=$1 AND outlet_id=$2 AND kind='backup' AND state='complete'",[parse(UUID,id),outlet.id])).rows[0];if(!row)throw new ApiError(404,'Backup not found');return{downloadUrl:await storage().download(row.object_key),metadata:row.metadata};
 };
 app.get('/v1/storage/backups',request=>installation(request,backups));
 app.get('/v1/storage/backups/:backupId',request=>installation(request,(client,outlet)=>backupDownload(client,outlet,(request.params as {backupId:string}).backupId)));
 app.get('/v1/outlets/:id/backups',request=>withOutlet(request,false,true,backups));
 app.get('/v1/outlets/:id/backups/:backupId',request=>withOutlet(request,false,true,(client,outlet)=>backupDownload(client,outlet,(request.params as {backupId:string}).backupId)));
 app.get('/v1/outlets/:id/media/:productId',request=>withOutlet(request,false,false,async(client,outlet)=>{
  const productId=parse(UUID,(request.params as {productId:string}).productId),row=(await client.query("SELECT object_key FROM storage_objects WHERE outlet_id=$1 AND kind='media' AND state='complete' AND metadata->>'productId'=$2 ORDER BY completed_at DESC LIMIT 1",[outlet.id,productId])).rows[0];if(!row)throw new ApiError(404,'Image not uploaded');return{url:await storage().download(row.object_key)};
 }));
 return app;
}
