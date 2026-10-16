import {Pool} from 'pg';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createCloudApi} from './server.js';
import {readRuntimeConfig,assertRuntimeDatabase,httpMailer} from './runtime.js';
import {s3Storage} from './storage.js';
import {azureBlobStorage,azureEmailMailer} from './azure.js';
import {subscriptionBridge} from './subscription-bridge.js';

export async function startCloud(env:Record<string,string|undefined>,dependencies:{
 pool?:(url:string)=>Pool;validate?:typeof assertRuntimeDatabase;api?:typeof createCloudApi;
}={}){
 const config=readRuntimeConfig(env);
 const pool=(dependencies.pool??(url=>new Pool({connectionString:url,max:20})))(config.databaseUrl);
 let app:Awaited<ReturnType<typeof createCloudApi>>|undefined;
 try{
  await (dependencies.validate??assertRuntimeDatabase)(pool);
  app=await (dependencies.api??createCloudApi)({pool,portalOrigin:config.portalOrigin,secureCookies:config.secureCookies,
   ...(env.HOSTED_POS_EMAIL?.trim()?{hostedPosEmail:env.HOSTED_POS_EMAIL.trim()}:{}),
   mailer:config.mail.provider==='azure'?azureEmailMailer(config.mail,config.portalOrigin):httpMailer(config.mail.url,config.mail.token,config.portalOrigin),
   storage:config.storage.provider==='azure'?azureBlobStorage(config.storage):s3Storage(config.storage),
   ...(config.licensingUrl&&config.licensingToken?{subscriptionBridge:subscriptionBridge(config.licensingUrl,config.licensingToken)}:{})});
  await app.listen({host:config.host,port:config.port});
 }catch(error){try{await app?.close();}finally{await pool.end();}throw error;}
 let closing:Promise<void>|undefined;
 return{app,close:()=>closing??= (async()=>{try{await app.close();}finally{await pool.end();}})()};
}

async function main(){
 const running=await startCloud(process.env);
 const stop=()=>{void running.close().catch(()=>{process.stderr.write('Cloud shutdown failed.\n');process.exitCode=1;});};
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 process.stdout.write('Cloud API listening.\n');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{
 process.stderr.write('Cloud startup failed; check runtime configuration, database access, and schema.\n');process.exitCode=1;
});
