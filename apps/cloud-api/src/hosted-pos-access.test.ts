import {afterAll,expect,it} from 'vitest';
import {Pool} from 'pg';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createCloudApi} from './server.js';
import {applyMigrations} from './migrate.js';
import {testPostgres} from './testing/postgres.js';

let db:Awaited<ReturnType<typeof testPostgres>>|undefined,pool:Pool|undefined;
afterAll(async()=>{await pool?.end();await db?.stop();});
it('protects the hosted restaurant with the selected owner account, not merely any valid cloud session',async()=>{
 db=await testPostgres();pool=new Pool({connectionString:db.url});await applyMigrations(pool,'disposable-password');
 const allowed=randomUUID(),other=randomUUID(),session=randomBytes(32).toString('base64url'),otherSession=randomBytes(32).toString('base64url');
 for(const [id,email,token] of [[allowed,'founder@example.test',session],[other,'other@example.test',otherSession]]){
  await pool.query("INSERT INTO accounts(id,email,platform_role,created_at) VALUES($1,$2,'platform_admin',0)",[id,email]);
  await pool.query('INSERT INTO web_sessions(token_hash,account_id,csrf_hash,expires_at,created_at) VALUES($1,$2,$3,$4,0)',[createHash('sha256').update(token!).digest('hex'),id,'unused',Date.now()+60000]);
 }
 const app=await createCloudApi({pool,portalOrigin:'https://portal.test',hostedPosEmail:'founder@example.test',mailer:{async deliver(){}}});
 try{
  expect((await app.inject('/v1/auth/pos-access')).statusCode).toBe(401);
  expect((await app.inject({url:'/v1/auth/pos-access',headers:{cookie:`__Host-forkflow_session=${otherSession}`}})).statusCode).toBe(403);
  expect((await app.inject({url:'/v1/auth/pos-access',headers:{cookie:`__Host-forkflow_session=${session}`}})).statusCode).toBe(204);
  await pool.query('UPDATE accounts SET disabled=true WHERE id=$1',[allowed]);
  expect((await app.inject({url:'/v1/auth/pos-access',headers:{cookie:`__Host-forkflow_session=${session}`}})).statusCode).toBe(401);
 }finally{await app.close();}
 const unconfigured=await createCloudApi({pool,portalOrigin:'https://portal.test',mailer:{async deliver(){}}});
 try{expect((await unconfigured.inject({url:'/v1/auth/pos-access',headers:{cookie:`__Host-forkflow_session=${otherSession}`}})).statusCode).toBe(403);}
 finally{await unconfigured.close();}
});
