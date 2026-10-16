import EmbeddedPostgres from 'embedded-postgres';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
export async function testPostgres() {
 if(process.env.CLOUD_TEST_DATABASE_URL) return {url:process.env.CLOUD_TEST_DATABASE_URL,stop:async()=>{}};
 const port=await new Promise<number>((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const address=server.address();if(!address||typeof address==='string')throw new Error('No port');server.close(()=>resolve(address.port));});});
 const directory=await mkdtemp(join(tmpdir(),'forkflow-cloud-')),data=join(directory,'data');
 const postgres=new EmbeddedPostgres({databaseDir:data,user:'postgres',password:'test-password',port,persistent:false,initdbFlags:['--encoding=UTF8','--locale=C'],onLog:()=>{},onError:message=>{throw new Error(String(message));}});
 await postgres.initialise();
 if(process.platform==='win32'){
  // pg_ctl drops elevated Windows privileges before starting PostgreSQL; direct spawn does not.
  const binary=join(dirname(createRequire(import.meta.url).resolve('@embedded-postgres/windows-x64')),'..','native','bin','pg_ctl.exe');
  const run=(file:string,args:string[])=>new Promise<void>((resolve,reject)=>{const child=spawn(file,args,{stdio:'ignore',windowsHide:true});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`pg_ctl exited ${code}`)));});
  await run(binary,['-D',data,'-o',`-p ${port} -h 127.0.0.1`,'-l',join(directory,'postgres.log'),'-w','start']);
  return{url:`postgresql://postgres:test-password@127.0.0.1:${port}/postgres`,stop:async()=>{await run(binary,['-D',data,'-m','fast','-w','stop']);}};
 }
 await postgres.start();return{url:`postgresql://postgres:test-password@127.0.0.1:${port}/postgres`,stop:()=>postgres.stop()};
}
