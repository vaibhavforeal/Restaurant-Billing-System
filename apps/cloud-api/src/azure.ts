import {BlobServiceClient,StorageSharedKeyCredential,BlobSASPermissions,SASProtocol} from '@azure/storage-blob';
import {EmailClient} from '@azure/communication-email';
import {AzureKeyCredential} from '@azure/core-auth';
import {createHash} from 'node:crypto';
import {ApiError} from './db.js';
import type {ObjectStorage} from './storage.js';

export function azureBlobStorage(config:{accountName:string;accountKey:string;container:string;endpoint?:string}):ObjectStorage {
 const credential=new StorageSharedKeyCredential(config.accountName,config.accountKey);
 const client=new BlobServiceClient(config.endpoint??`https://${config.accountName}.blob.core.windows.net`,credential,{retryOptions:{maxTries:2}});
 const container=client.getContainerClient(config.container),blob=(key:string)=>container.getBlockBlobClient(key);
 const signed=(key:string,permissions:string,seconds:number)=>blob(key).generateSasUrl({permissions:BlobSASPermissions.parse(permissions),protocol:SASProtocol.Https,startsOn:new Date(Date.now()-60000),expiresOn:new Date(Date.now()+seconds*1000)});
 return {
  async upload(key,_bytes,sha256){return {uploadUrl:await signed(key,'c',900),headers:{'content-type':'application/octet-stream','x-ms-blob-type':'BlockBlob','x-ms-meta-sha256':sha256}};},
  async verify(key,bytes,sha256){
   const target=blob(key),head=await target.getProperties();
   if(head.contentLength!==bytes||!head.etag)throw new ApiError(409,'Uploaded object length mismatch');
   const result=await target.download(0,undefined,{conditions:{ifMatch:head.etag}});
   if(!result.readableStreamBody)throw new ApiError(409,'Uploaded object missing');
   const digest=createHash('sha256');let received=0;
   for await(const chunk of result.readableStreamBody){const data=Buffer.from(chunk);received+=data.byteLength;if(received>bytes)throw new ApiError(409,'Uploaded object length mismatch');digest.update(data);}
   if(received!==bytes||digest.digest('hex')!==sha256)throw new ApiError(409,'Uploaded object checksum mismatch');
   return {etag:head.etag};
  },
  async promote(source,key,etag){await blob(key).syncUploadFromURL(await signed(source,'r',300),{sourceConditions:{ifMatch:etag}});},
  async download(key){return signed(key,'r',300);},
  async remove(key){await blob(key).deleteIfExists();},
 };
}

export function azureEmailMailer(config:{endpoint:string;accessKey:string;sender:string},portalOrigin:string){
 const client=new EmailClient(config.endpoint,new AzureKeyCredential(config.accessKey),{allowInsecureConnection:config.endpoint.startsWith('http://'),retryOptions:{maxRetries:2}});
 return {async deliver(message:{email:string;token:string;kind:'invite'|'reset';expiresAt:number}){
  const link=new URL(message.kind==='invite'?'/invite':'/reset',portalOrigin);link.searchParams.set('token',message.token);
  const action=message.kind==='invite'?'Accept your ForkFlow invitation':'Reset your ForkFlow password';
  const poller=await client.beginSend({senderAddress:config.sender,recipients:{to:[{address:message.email}]},content:{subject:action,
   plainText:`${action}:\n\n${link.href}\n\nThis link expires at ${new Date(message.expiresAt).toISOString()}. If you did not request this, you can ignore this email.`}},{abortSignal:AbortSignal.timeout(15000),updateIntervalInMs:1000});
  const result=await poller.pollUntilDone({abortSignal:AbortSignal.timeout(15000)});
  if(result.status!=='Succeeded')throw new Error('Mail delivery unavailable');
 }};
}
