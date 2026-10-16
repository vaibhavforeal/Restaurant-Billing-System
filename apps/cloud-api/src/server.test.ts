import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { testPostgres } from './testing/postgres.js';
import { hash, transaction } from './db.js';
import { createCloudApi } from './server.js';
import type {ObjectStorage} from './storage.js';

describe('cloud tenant and installation integration (real PostgreSQL)', () => {
  let admin:Pool;
  let database:Awaited<ReturnType<typeof testPostgres>>;
  let runtime: Pool;
  let api: Awaited<ReturnType<typeof createCloudApi>>;
  const delivered: Array<{email:string;token:string;kind:string}> = [];
  const objectBytes=new Map<string,{sha256:string;bytes:number;etag:string}>();
  const storage:ObjectStorage={async upload(key,_bytes,sha256){return{uploadUrl:`https://storage.test/${key}`,headers:{'x-amz-meta-sha256':sha256}};},async verify(key,bytes,sha256){const found=objectBytes.get(key);if(!found||found.bytes!==bytes||found.sha256!==sha256)throw new Error('Checksum mismatch');return{etag:found.etag};},async promote(source,key,etag){const found=objectBytes.get(source);if(!found||found.etag!==etag)throw new Error('Changed staging object');objectBytes.set(key,found);},async download(key){if(!objectBytes.has(key))throw new Error('Missing object');return`https://storage.test/${key}`;},async remove(key){objectBytes.delete(key);}};
  const origin = 'https://portal.test';
  const adminId=randomUUID(), installationId=randomUUID(), productId=randomUUID(),billId=randomUUID();
  let cookie='',csrf='',organizationId='',outletId='',credential='',epoch='';
  const post=(url:string,payload:unknown,session=true)=>api.inject({method:'POST',url,payload:JSON.stringify(payload),headers:{'content-type':'application/json',...(session?{cookie,origin,'x-csrf-token':csrf}:{})}});
  const get=(url:string)=>api.inject({url,headers:{cookie}});
  const sync=(url:string,payload:unknown)=>api.inject({method:'POST',url,payload:JSON.stringify(payload),headers:{'content-type':'application/json',authorization:`Bearer ${credential}`}});
  beforeAll(async () => {
    database=await testPostgres();const url=database.url;
    admin=new Pool({connectionString:url});
    await admin.query(await readFile(new URL('../migrations/001-platform.sql', import.meta.url), 'utf8'));
    await admin.query(await readFile(new URL('../migrations/002-storage.sql',import.meta.url),'utf8'));
    const password=await argon2.hash('correct horse battery staple',{type:argon2.argon2id});
    for(const [id,email,role] of [[adminId,'operator@test.example','platform_admin'],[randomUUID(),'other@test.example','owner']]) await admin.query('INSERT INTO accounts(id,email,password_hash,platform_role,created_at) VALUES($1,$2,$3,$4,$5)',[id,email,password,role,Date.now()]);
    runtime = new Pool({ connectionString: url, options: '-c role=forkflow_cloud' });
    api = await createCloudApi({ pool: runtime, portalOrigin: origin, storage,mailer: { async deliver(message:{email:string;token:string;kind:string}) { delivered.push(message); } } });
  },120000);
  afterAll(async () => { await api?.close(); await runtime?.end(); await admin?.end();await database?.stop(); });
  test('does not expose login or tenant data anonymously', async () => {
    expect((await api.inject({method:'GET',url:'/v1/auth/me'})).statusCode).toBe(401);
    expect((await api.inject({method:'GET',url:'/v1/outlets'})).statusCode).toBe(401);
  });
  test('runtime role cannot bypass or modify immutable journal', async () => {
    const role = await runtime.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user');
    expect(role.rows[0]).toEqual({rolsuper:false,rolbypassrls:false});
    expect((await runtime.query('SELECT * FROM outlets')).rows).toEqual([]);
    await expect(runtime.query('DELETE FROM sync_journal')).rejects.toThrow();
  });
  test('login protects cookies and requires Origin and CSRF on mutations',async()=>{
   expect((await post('/v1/auth/login',{email:'operator@test.example',password:'incorrect'},false)).statusCode).toBe(401);
   const login=await api.inject({method:'POST',url:'/v1/auth/login',headers:{origin},payload:{email:'operator@test.example',password:'correct horse battery staple'}});
   expect(login.statusCode).toBe(200);const setCookie=String(login.headers['set-cookie']);
   for(const flag of ['HttpOnly','Secure','SameSite=Strict'])expect(setCookie).toContain(flag);
   cookie=setCookie.split(';')[0]!;csrf=login.json().csrfToken;
   expect((await api.inject({method:'POST',url:'/v1/platform/organizations',headers:{cookie,origin},payload:{name:'Restaurant A',email:'owner@test.example'}})).statusCode).toBe(403);
   expect((await api.inject({method:'POST',url:'/v1/platform/organizations',headers:{cookie,origin:'https://evil.example','x-csrf-token':csrf},payload:{name:'Restaurant A',email:'owner@test.example'}})).statusCode).toBe(403);
   const org=await post('/v1/platform/organizations',{name:'Restaurant A',email:'owner@test.example'});expect(org.statusCode).toBe(201);organizationId=org.json().organization.id;
  });
  test('invitations store hashes, grant owner access, and cannot be replayed',async()=>{
   const invite=delivered.at(-1)!;expect(invite.kind).toBe('invite');
   expect((await admin.query('SELECT token_hash FROM account_tokens WHERE token_hash=$1',[hash(invite.token)])).rowCount).toBe(1);
   expect((await post('/v1/auth/invite/consume',{token:invite.token,password:'owner strong password'},false)).statusCode).toBe(200);
   expect((await post('/v1/auth/invite/consume',{token:invite.token,password:'owner strong password'},false)).statusCode).toBe(400);
   const login=await api.inject({method:'POST',url:'/v1/auth/login',headers:{origin},payload:{email:'owner@test.example',password:'owner strong password'}});
   expect(login.statusCode).toBe(200);cookie=String(login.headers['set-cookie']).split(';')[0]!;csrf=login.json().csrfToken;
   expect((await get('/v1/organizations')).json().organizations).toEqual([{id:organizationId,name:'Restaurant A',role:'owner'}]);
   const outlets=await post('/v1/outlets',{organizationId,name:'Main Outlet'});expect(outlets.statusCode).toBe(201);outletId=outlets.json().outlet.id;
   expect((await post('/v1/platform/invitations',{email:'bad@test.example',organizationId,role:'owner'})).statusCode).toBe(403);
  });
  test('one-use pairing binds a single installation and rejects duplicate pairing',async()=>{
   const pairing=await post(`/v1/outlets/${outletId}/pairing`,{});expect(pairing.statusCode).toBe(200);
   const paired=await post('/v1/outlets/pair',{code:pairing.json().code,installationId},false);expect(paired.statusCode).toBe(200);({credential,epoch}=paired.json());
   expect(paired.json().outletId).toBe(outletId);expect((await post('/v1/outlets/pair',{code:pairing.json().code,installationId},false)).statusCode).toBe(401);
   expect((await post(`/v1/outlets/${outletId}/pairing`,{})).statusCode).toBe(409);
  });
  test('bootstrap and push are atomic, sequential, immutable and idempotent',async()=>{
   const base={protocolVersion:1,outletId,installationId,epoch};
   const bootstrap={...base,sequence:3,records:[{table:'products',key:{id:productId},row:{id:productId,name:'Tea',price_paise:1000},revision:2},{table:'bills',key:{id:billId},row:{id:billId,subtotal_paise:1000,discount_paise:0,cgst_paise:25,sgst_paise:25,total_paise:1050,created_at:Date.now()},revision:3}]};
   expect((await sync('/v1/sync/bootstrap',bootstrap)).json()).toEqual({acknowledgedSequence:3});expect((await sync('/v1/sync/bootstrap',bootstrap)).statusCode).toBe(200);
   expect((await sync('/v1/sync/bootstrap',{...bootstrap,sequence:4})).statusCode).toBe(409);
   const event={...base,sequence:4,eventId:randomUUID(),occurredAt:Date.now(),changes:[{table:'products',key:{id:productId},row:{id:productId,name:'Tea',price_paise:1500}}]};
   expect((await sync('/v1/sync/push',{events:[{...event,sequence:5}]})).statusCode).toBe(409);
   expect((await sync('/v1/sync/push',{events:[event]})).json()).toEqual({acknowledgedSequence:4});expect((await sync('/v1/sync/push',{events:[event]})).json()).toEqual({acknowledgedSequence:4});
   expect((await sync('/v1/sync/push',{events:[{...event,changes:[{table:'products',key:{id:productId},row:{price_paise:9}}]}]})).statusCode).toBe(409);
   expect((await get(`/v1/outlets/${outletId}/records?table=products`)).json().records[0]).toMatchObject({revision:4,row:{price_paise:1500}});
   expect((await get(`/v1/outlets/${outletId}/reports`)).json().totals).toMatchObject({grandTotalPaise:'1050',cgstPaise:'25',sgstPaise:'25',taxablePaise:'1000',billCount:1});
  });
  test('management commands validate payload and compare revisions',async()=>{
   const url=`/v1/outlets/${outletId}/commands`;
   expect((await post(url,{kind:'product.update',targetId:productId,expectedRevision:3,payload:{pricePaise:2000}})).statusCode).toBe(409);
   expect((await post(url,{kind:'product.update',targetId:productId,expectedRevision:4,payload:{password:'leak'}})).statusCode).toBe(400);
   const response=await post(url,{kind:'product.update',targetId:productId,expectedRevision:4,payload:{pricePaise:2000}});expect(response.statusCode).toBe(201);
   expect((await api.inject({url:'/v1/sync/commands',headers:{authorization:`Bearer ${credential}`}})).json().commands[0]).toMatchObject({id:response.json().command.id,expectedRevision:4});
   expect((await sync('/v1/sync/commands',{results:[{id:response.json().command.id,status:'conflict',revision:5}]})).statusCode).toBe(200);
   expect((await api.inject({url:'/v1/sync/commands',headers:{authorization:`Bearer ${credential}`}})).json().commands).toEqual([]);
  });
  test('reports use immutable issue dates, credit offsets, decimal stock and unknown cost facts',async()=>{
   const created=Date.UTC(2026,9,12,12),creditId=randomUUID(),itemId=randomUUID();
   const records=[
    {table:'bill_report_lines',key:{bill_id:billId,order_item_id:itemId},row:{bill_id:billId,order_item_id:itemId,product_id:productId,name:'Tea',category_name:'Drinks',qty:2,subtotal_paise:1000,taxable_paise:1000,total_paise:1050}},
    {table:'credit_notes',key:{id:creditId},row:{id:creditId,bill_id:billId,cn_no:1,kind:'refund',total_paise:525,created_at:created,approved_by:adminId}},
    {table:'credit_note_lines',key:{credit_note_id:creditId,order_item_id:itemId},row:{credit_note_id:creditId,order_item_id:itemId,name:'Tea',category_name:'Drinks',qty:1,taxable_paise:500,total_paise:525}},
    {table:'stock_items',key:{id:'s1'},row:{id:'s1',name:'Milk',unit:'L',qty:0.875}},
    {table:'stock_moves',key:{id:'m1'},row:{id:'m1',stock_item_id:'s1',order_item_id:itemId,delta:-0.125,reason:'sale',cost_paise:null,created_at:created}},
   ];
   expect((await sync('/v1/sync/push',{events:[{protocolVersion:1,outletId,installationId,epoch,sequence:5,eventId:randomUUID(),occurredAt:created,changes:records}]})).statusCode).toBe(200);
   const path=`/v1/outlets/${outletId}/reports/operations/`;
   const items=(await get(path+'items')).json().report;expect(items.tables[0].rows[0]).toMatchObject({qty:2,creditQty:1,netQty:1,netTotal:'525'});
   const stock=(await get(path+'stock')).json().report;expect(stock.tables[0].rows[0]).toMatchObject({opening:1,consumed:0.125,closing:0.875});
   const profit=(await get(path+'profit')).json().report;expect(profit.tables[0].rows.find((row:any)=>row.metric==='Excluded: cost unknown')).toMatchObject({amount:'500'});expect(profit.tables[2].rows[0]).toMatchObject({profit:null,status:'Cost unknown'});
   for(const kind of ['cashiers','hourly','kots','cancellations','credit-notes','analytics','day-end'])expect((await get(path+kind)).statusCode).toBe(200);
   const credits=(await get(`/v1/outlets/${outletId}/reports?from=2026-10-12&to=2026-10-12`)).json();expect(credits.totals.creditNotePaise).toBe('525');
   expect((await get(path+'items?from=2026-02-30')).statusCode).toBe(400);
  });
  test('storage completion verifies content and recovery returns only active tenant backups and journal',async()=>{
   const sha256='a'.repeat(64),objectId=randomUUID();const metadata={id:objectId,format:'ffbk1',outletId,installationId,epoch,sequence:5,createdAt:Date.now(),keyId:'b'.repeat(64),sha256,bytes:100};
   const input={kind:'backup',objectId,sha256,bytes:100,metadata};const ticket=await sync('/v1/storage/upload',input);expect(ticket.statusCode).toBe(200);
   expect(ticket.json().objectKey).toContain(organizationId);expect(ticket.json().objectKey).toContain(outletId);
   expect((await sync('/v1/storage/complete',input)).statusCode).not.toBe(200);
   const stagingKey=new URL(ticket.json().uploadUrl).pathname.slice(1);objectBytes.set(stagingKey,{sha256,bytes:100,etag:'v1'});
   expect((await sync('/v1/storage/complete',input)).statusCode).toBe(200);expect((await sync('/v1/storage/complete',input)).statusCode).toBe(200);
   expect((await api.inject({url:'/v1/storage/backups',headers:{authorization:`Bearer ${credential}`}})).json().backups).toEqual([metadata]);
   const download=await api.inject({url:`/v1/storage/backups/${objectId}`,headers:{authorization:`Bearer ${credential}`}});expect(download.statusCode).toBe(200);expect(download.json().metadata).toEqual(metadata);
   expect((await get(`/v1/outlets/${outletId}/backups/${objectId}`)).statusCode).toBe(200);
   expect((await sync('/v1/storage/upload',{...input,metadata:{...metadata,outletId:randomUUID()}})).statusCode).toBe(400);
   expect((await sync('/v1/storage/complete',{...input,sha256:'c'.repeat(64)})).statusCode).toBe(400);
   expect((await sync('/v1/storage/complete',{...input,sha256:'c'.repeat(64),metadata:{...metadata,sha256:'c'.repeat(64)}})).statusCode).toBe(409);
   const journal=await api.inject({url:'/v1/sync/journal?after=3&limit=1',headers:{authorization:`Bearer ${credential}`}});expect(journal.statusCode).toBe(200);expect(journal.json().events[0].sequence).toBe(4);expect(journal.json().highWatermark).toBe(5);
  });
  test('guessed tenant records are invisible and revocation invalidates credentials',async()=>{
   const outsider=await api.inject({method:'POST',url:'/v1/auth/login',headers:{origin},payload:{email:'other@test.example',password:'correct horse battery staple'}});
   expect((await api.inject({url:`/v1/outlets/${outletId}/records`,headers:{cookie:String(outsider.headers['set-cookie']).split(';')[0]!}})).statusCode).toBe(404);
   await transaction(runtime,randomUUID(),async client=>expect((await client.query('SELECT * FROM projections WHERE outlet_id=$1',[outletId])).rows).toEqual([]));
   expect((await post(`/v1/outlets/${outletId}/revoke`,{})).statusCode).toBe(200);
   expect((await api.inject({url:'/v1/sync/commands',headers:{authorization:`Bearer ${credential}`}})).statusCode).toBe(401);
  });
  test('password reset invalidates account sessions and rejects replay',async()=>{
   expect((await post('/v1/auth/reset/request',{email:'owner@test.example'},false)).statusCode).toBe(202);const reset=delivered.at(-1)!;
   expect((await post('/v1/auth/reset/consume',{token:reset.token,password:'a new strong password'},false)).statusCode).toBe(200);
   expect((await get('/v1/auth/me')).statusCode).toBe(401);
   expect((await post('/v1/auth/reset/consume',{token:reset.token,password:'a new strong password'},false)).statusCode).toBe(400);
  });
});
