import {expect,it} from 'vitest';
import {readRuntimeConfig} from './runtime.js';
const azureEnv={NODE_ENV:'production',DATABASE_URL:'postgresql://app:password@db/cloud',PORTAL_ORIGIN:'https://portal.example',
 MAIL_PROVIDER:'azure',AZURE_EMAIL_ENDPOINT:'https://forkflow.communication.azure.com',AZURE_EMAIL_ACCESS_KEY:'secret',AZURE_EMAIL_SENDER:'DoNotReply@azurecomm.net',
 STORAGE_PROVIDER:'azure',AZURE_STORAGE_ACCOUNT:'forkflowaccount',AZURE_STORAGE_KEY:'secret',AZURE_STORAGE_CONTAINER:'private'};
it('accepts Azure-only services without requiring unrelated S3 or HTTP-mail secrets',()=>{
 const config=readRuntimeConfig(azureEnv);
 expect(config.mail.provider).toBe('azure');expect(config.storage.provider).toBe('azure');
});
it('fails closed on unknown providers, missing Azure secrets and insecure endpoints',()=>{
 expect(()=>readRuntimeConfig({...azureEnv,STORAGE_PROVIDER:'other'})).toThrow(/STORAGE_PROVIDER/);
 expect(()=>readRuntimeConfig({...azureEnv,MAIL_PROVIDER:'other'})).toThrow(/MAIL_PROVIDER/);
 expect(()=>readRuntimeConfig({...azureEnv,AZURE_EMAIL_ACCESS_KEY:''})).toThrow(/AZURE_EMAIL_ACCESS_KEY/);
 expect(()=>readRuntimeConfig({...azureEnv,AZURE_STORAGE_KEY:''})).toThrow(/AZURE_STORAGE_KEY/);
 expect(()=>readRuntimeConfig({...azureEnv,AZURE_EMAIL_ENDPOINT:'http://mail.example'})).toThrow(/HTTPS/);
 expect(()=>readRuntimeConfig({...azureEnv,AZURE_STORAGE_ENDPOINT:'http://blob.example'})).toThrow(/HTTPS/);
 expect(()=>readRuntimeConfig({...azureEnv,AZURE_STORAGE_CONTAINER:'../public'})).toThrow(/container/i);
});
