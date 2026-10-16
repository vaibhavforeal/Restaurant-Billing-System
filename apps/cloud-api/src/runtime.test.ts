import {afterAll, describe, expect, it} from 'vitest';
import {Pool} from 'pg';
import {readRuntimeConfig, assertRuntimeDatabase, httpMailer} from './runtime.js';
import {applyMigrations} from './migrate.js';
import {testPostgres} from './testing/postgres.js';

describe('cloud runtime',()=>{
 it('requires secure production origin and configured delivery and storage',()=>{
  const env={NODE_ENV:'production',DATABASE_URL:'postgresql://app:password@db/cloud',PORTAL_ORIGIN:'http://portal.example',MAIL_DELIVERY_URL:'https://mail.example/deliver',MAIL_DELIVERY_TOKEN:'token',S3_BUCKET:'bucket',S3_REGION:'us-east-1',S3_ACCESS_KEY_ID:'key',S3_SECRET_ACCESS_KEY:'secret'};
  expect(()=>readRuntimeConfig(env)).toThrow(/HTTPS/);
  expect(()=>readRuntimeConfig({...env,PORTAL_ORIGIN:'https://portal.example',MAIL_DELIVERY_TOKEN:''})).toThrow(/MAIL_DELIVERY_TOKEN/);
  expect(readRuntimeConfig({...env,PORTAL_ORIGIN:'https://portal.example'}).secureCookies).toBe(true);
 });
 it('delivers a browser link without putting the token in the endpoint URL',async()=>{
  let called:Request|undefined;
  const transport:typeof fetch=async(input,init)=>{called=new Request(input,init);return new Response(null,{status:202});};
  const mailer=httpMailer('https://mail.example/deliver','service-token','https://portal.example',transport);
  await mailer.deliver({email:'owner@example.test',token:'abc',kind:'invite',expiresAt:123});
  expect(called?.url).toBe('https://mail.example/deliver');
  expect(called?.headers.get('authorization')).toBe('Bearer service-token');
  expect(JSON.parse(await called!.text())).toEqual({to:'owner@example.test',kind:'invite',url:'https://portal.example/invite?token=abc',expiresAt:123});
 });
});

describe('cloud database startup gate',()=>{
 let database:Awaited<ReturnType<typeof testPostgres>>|undefined;
 afterAll(async()=>{await database?.stop();});
 it('rejects admin connection and accepts only the migrated restricted app role',async()=>{
  database=await testPostgres();
  const admin=new Pool({connectionString:database.url});
  try{
   await expect(assertRuntimeDatabase(admin)).rejects.toThrow();
   await applyMigrations(admin,'disposable-test-password');
   const url=new URL(database.url);url.username='forkflow_cloud_app';url.password='disposable-test-password';
   const app=new Pool({connectionString:url.href});
   try{await expect(assertRuntimeDatabase(app)).resolves.toBeUndefined();}
   finally{await app.end();}
  }finally{await admin.end();}
 });
});
