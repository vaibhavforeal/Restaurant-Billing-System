import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {Pool} from 'pg';

const migrations=['001-platform.sql','002-storage.sql','003-runtime-access.sql'];
export async function applyMigrations(pool:Pool,appPassword:string){
 if(!appPassword||appPassword.length<16)throw new Error('CLOUD_APP_PASSWORD must be at least 16 characters');
 const client=await pool.connect();
 try{
  await client.query('SELECT pg_advisory_lock(6127,4200)');
  const exists=(await client.query("SELECT to_regclass('public.cloud_migrations') AS name")).rows[0]?.name;
  const applied=exists?(await client.query('SELECT version FROM public.cloud_migrations')).rows.map(row=>Number(row.version)):[];
  if(applied.some(version=>!Number.isInteger(version)||version<1||version>migrations.length))throw new Error('Unknown cloud schema version; refusing migration');
  for(let i=0;i<migrations.length;i++){
   const version=i+1;if(applied.includes(version))continue;
   const sql=await readFile(new URL(`../migrations/${migrations[i]}`,import.meta.url),'utf8');
   await client.query(sql);
   const verified=(await client.query('SELECT 1 FROM public.cloud_migrations WHERE version=$1',[version])).rowCount;
   if(!verified)throw new Error(`Migration ${version} did not record its version`);
  }
  const role='forkflow_cloud_app';
  const present=(await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount;
  const statement=(await client.query(`SELECT format($1::text,$2::text,$3::text) AS sql`,[
   present?'ALTER ROLE %I WITH LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L':'CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
   role,appPassword])).rows[0].sql as string;
  await client.query(statement);
  await client.query('GRANT forkflow_cloud TO forkflow_cloud_app');
 }finally{await client.query('SELECT pg_advisory_unlock(6127,4200)').catch(()=>{});client.release();}
}

async function main(){
 const connectionString=process.env.CLOUD_MIGRATION_DATABASE_URL,appPassword=process.env.CLOUD_APP_PASSWORD;
 if(!connectionString||!appPassword)throw new Error('CLOUD_MIGRATION_DATABASE_URL and CLOUD_APP_PASSWORD are required');
 const pool=new Pool({connectionString,max:1});
 try{await applyMigrations(pool,appPassword);process.stdout.write('Cloud migrations applied.\n');}finally{await pool.end();}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))main().catch(error=>{process.stderr.write(`Migration failed: ${error instanceof Error?error.message:'unknown error'}\n`);process.exitCode=1;});
