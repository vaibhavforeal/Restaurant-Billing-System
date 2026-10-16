import type {Pool} from 'pg';

type Environment=Record<string,string|undefined>;
type MailConfig={provider:'http';url:string;token:string}|{provider:'azure';endpoint:string;accessKey:string;sender:string};
type StorageConfig={provider:'s3';region:string;bucket:string;accessKeyId:string;secretAccessKey:string;endpoint?:string;forcePathStyle:boolean}
 |{provider:'azure';accountName:string;accountKey:string;container:string;endpoint?:string};
const required=(env:Environment,name:string)=>{const value=env[name]?.trim();if(!value)throw new Error(`${name} is required`);return value;};
const endpoint=(value:string,label:string,localHttp=false)=>{
 let url:URL;try{url=new URL(value);}catch{throw new Error(`${label} must be a valid URL`);}
 if(url.username||url.password||url.search||url.hash)throw new Error(`${label} cannot contain credentials, query, or fragment`);
 if(url.protocol!=='https:'&&!(localHttp&&url.protocol==='http:'))throw new Error(`${label} requires HTTPS`);
 return url;
};
const localhost=(url:URL)=>['localhost','127.0.0.1','::1','[::1]'].includes(url.hostname);
export function readRuntimeConfig(env:Environment){
 const production=env.NODE_ENV==='production';
 const databaseUrl=required(env,'DATABASE_URL');
 const database=new URL(databaseUrl);if(!['postgres:','postgresql:'].includes(database.protocol))throw new Error('DATABASE_URL must be PostgreSQL');
 const originUrl=endpoint(required(env,'PORTAL_ORIGIN'),'PORTAL_ORIGIN',!production);
 if(originUrl.pathname!=='/'||originUrl.href!==originUrl.origin+'/')throw new Error('PORTAL_ORIGIN must be an origin without a path');
 const insecure=env.CLOUD_COOKIE_INSECURE==='true';
 if(insecure&&(production||!localhost(originUrl)))throw new Error('Insecure cookies are only allowed for local development');
 const mailProvider=env.MAIL_PROVIDER?.trim()||'http',storageProvider=env.STORAGE_PROVIDER?.trim()||'s3';
 if(!['http','azure'].includes(mailProvider))throw new Error('MAIL_PROVIDER must be http or azure');
 if(!['s3','azure'].includes(storageProvider))throw new Error('STORAGE_PROVIDER must be s3 or azure');
 let mail:MailConfig,storage:StorageConfig;
 if(mailProvider==='azure'){
  const sender=required(env,'AZURE_EMAIL_SENDER');if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender))throw new Error('AZURE_EMAIL_SENDER must be an email address');
  mail={provider:'azure',endpoint:endpoint(required(env,'AZURE_EMAIL_ENDPOINT'),'AZURE_EMAIL_ENDPOINT',!production).href,accessKey:required(env,'AZURE_EMAIL_ACCESS_KEY'),sender};
 }else mail={provider:'http',url:endpoint(required(env,'MAIL_DELIVERY_URL'),'MAIL_DELIVERY_URL',!production).href,token:required(env,'MAIL_DELIVERY_TOKEN')};
 if(storageProvider==='azure'){
  const accountName=required(env,'AZURE_STORAGE_ACCOUNT'),container=required(env,'AZURE_STORAGE_CONTAINER');
  if(!/^[a-z0-9]{3,24}$/.test(accountName))throw new Error('Azure storage account name is invalid');
  if(!/^[a-z0-9](?:[a-z0-9-]{1,61})[a-z0-9]$/.test(container)||container.includes('--'))throw new Error('Azure storage container name is invalid');
  storage={provider:'azure',accountName,container,accountKey:required(env,'AZURE_STORAGE_KEY'),...(env.AZURE_STORAGE_ENDPOINT?{endpoint:endpoint(env.AZURE_STORAGE_ENDPOINT,'AZURE_STORAGE_ENDPOINT',!production).href}:{})};
 }else storage={provider:'s3',region:required(env,'S3_REGION'),bucket:required(env,'S3_BUCKET'),accessKeyId:required(env,'S3_ACCESS_KEY_ID'),secretAccessKey:required(env,'S3_SECRET_ACCESS_KEY'),
  ...(env.S3_ENDPOINT?{endpoint:endpoint(env.S3_ENDPOINT,'S3_ENDPOINT',!production).href}:{}),forcePathStyle:env.S3_FORCE_PATH_STYLE==='true'};
 const licensingUrl=env.LICENSING_BASE_URL?.trim(),licensingToken=env.LICENSING_SERVICE_TOKEN?.trim();
 if(Boolean(licensingUrl)!==Boolean(licensingToken))throw new Error('LICENSING_BASE_URL and LICENSING_SERVICE_TOKEN must be set together');
 const port=Number(env.PORT??'4200');if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT must be 1-65535');
 return {databaseUrl,portalOrigin:originUrl.origin,secureCookies:!insecure,mail,storage,
  licensingUrl,licensingToken,host:env.HOST?.trim()||'0.0.0.0',port};
}

export function httpMailer(deliveryUrl:string,serviceToken:string,portalOrigin:string,transport:typeof fetch=fetch){
 return {async deliver(message:{email:string;token:string;kind:'invite'|'reset';expiresAt:number}){
  const path=message.kind==='invite'?'/invite':'/reset';const link=new URL(path,portalOrigin);link.searchParams.set('token',message.token);
  const response=await transport(deliveryUrl,{method:'POST',headers:{authorization:`Bearer ${serviceToken}`,'content-type':'application/json'},
   body:JSON.stringify({to:message.email,kind:message.kind,url:link.href,expiresAt:message.expiresAt}),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('Mail delivery unavailable');
 }};
}

const tenantTables=['outlets','sync_journal','projections','management_commands','subscriptions','audit_log','storage_objects'];
export async function assertRuntimeDatabase(pool:Pool):Promise<void>{
 const role=(await pool.query(`SELECT current_user AS name,r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,
  pg_has_role(current_user,'forkflow_cloud','USAGE') AS has_cloud_grants
  FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
 if(!role||role.rolsuper||role.rolbypassrls||role.rolcreatedb||role.rolcreaterole||!role.has_cloud_grants||role.name==='forkflow_cloud')
  throw new Error('DATABASE_URL must use a restricted cloud application role');
 const owner=(await pool.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) LIMIT 1`)).rowCount;
 if(owner)throw new Error('Cloud application role cannot own application tables');
 let versions:number[];
 try{versions=(await pool.query('SELECT version FROM public.cloud_migrations ORDER BY version')).rows.map(row=>Number(row.version));}
 catch{throw new Error('Cloud schema is missing or the runtime role cannot read migrations');}
 if(versions.join(',')!=='1,2,3')throw new Error(`Cloud schema version is incompatible (expected 1,2,3; found ${versions.join(',')||'none'})`);
 const rls=(await pool.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c
  JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[])`,[tenantTables])).rows;
 if(rls.length!==tenantTables.length||rls.some(row=>!row.relrowsecurity||!row.relforcerowsecurity))throw new Error('Tenant row security is missing or not forced');
}
