import {Pool} from 'pg';
import argon2 from 'argon2';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {z} from 'zod';

export async function bootstrapAdmin(pool:Pool,email:string,password:string){
 const input=z.object({email:z.string().trim().toLowerCase().email().max(254),password:z.string().min(12).max(256)}).parse({email,password});
 const passwordHash=await argon2.hash(input.password,{type:argon2.argon2id}),client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(6127,4201)');
  if((await client.query("SELECT 1 FROM accounts WHERE platform_role='platform_admin' OR email=$1 LIMIT 1",[input.email])).rowCount)
   throw new Error('Administrator or account already exists; bootstrap cannot change existing access');
  await client.query("INSERT INTO accounts(id,email,password_hash,platform_role,created_at) VALUES($1,$2,$3,'platform_admin',$4)",[randomUUID(),input.email,passwordHash,Date.now()]);
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function main(){
 const url=process.env.CLOUD_MIGRATION_DATABASE_URL,email=process.env.CLOUD_ADMIN_EMAIL,password=process.env.CLOUD_ADMIN_PASSWORD;
 if(!url||!email||!password)throw new Error('Bootstrap configuration missing');
 const pool=new Pool({connectionString:url,max:1});
 try{await bootstrapAdmin(pool,email,password);process.stdout.write('First platform administrator created.\n');}finally{await pool.end();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{
 process.stderr.write('Administrator bootstrap failed; check configuration and existing accounts.\n');process.exitCode=1;
});
