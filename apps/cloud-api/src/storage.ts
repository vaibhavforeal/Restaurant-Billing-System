import {S3Client,PutObjectCommand,GetObjectCommand,HeadObjectCommand,CopyObjectCommand,DeleteObjectCommand} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import {createHash} from 'node:crypto';
import {ApiError} from './db.js';
export interface ObjectStorage {
 upload(key:string,bytes:number,sha256:string):Promise<{uploadUrl:string;headers:Record<string,string>}>;
 verify(key:string,bytes:number,sha256:string):Promise<{etag:string}>;
 promote(source:string,key:string,etag:string):Promise<void>;
 download(key:string):Promise<string>;
 remove(key:string):Promise<void>;
}
export function s3Storage(config:{endpoint?:string;region:string;bucket:string;accessKeyId:string;secretAccessKey:string;forcePathStyle?:boolean}):ObjectStorage {
 const client=new S3Client({region:config.region,...(config.endpoint?{endpoint:config.endpoint}:{}),credentials:{accessKeyId:config.accessKeyId,secretAccessKey:config.secretAccessKey},forcePathStyle:config.forcePathStyle??false,requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'}),Bucket=config.bucket;
 return{
  async upload(key,bytes,sha256){return{uploadUrl:await getSignedUrl(client,new PutObjectCommand({Bucket,Key:key,ContentLength:bytes,ContentType:'application/octet-stream',Metadata:{sha256}}),{expiresIn:900}),headers:{'content-type':'application/octet-stream','x-amz-meta-sha256':sha256}};},
  async verify(key,bytes,sha256){
   const head=await client.send(new HeadObjectCommand({Bucket,Key:key}));if(head.ContentLength!==bytes||!head.ETag)throw new ApiError(409,'Uploaded object length mismatch');
   // R2/S3 metadata is caller supplied. Verify actual ciphertext/media bytes, never trust metadata as proof.
   const result=await client.send(new GetObjectCommand({Bucket,Key:key,IfMatch:head.ETag}));if(!result.Body)throw new ApiError(409,'Uploaded object missing');
   const digest=createHash('sha256');let received=0;for await(const chunk of result.Body as AsyncIterable<Uint8Array>){received+=chunk.byteLength;if(received>bytes)throw new ApiError(409,'Uploaded object length mismatch');digest.update(chunk);}
   if(received!==bytes||digest.digest('hex')!==sha256)throw new ApiError(409,'Uploaded object checksum mismatch');return{etag:head.ETag};
  },
  async promote(source,key,etag){await client.send(new CopyObjectCommand({Bucket,Key:key,CopySource:`${Bucket}/${source.split('/').map(encodeURIComponent).join('/')}`,CopySourceIfMatch:etag}));},
  async download(key){return getSignedUrl(client,new GetObjectCommand({Bucket,Key:key}),{expiresIn:300});},
  async remove(key){await client.send(new DeleteObjectCommand({Bucket,Key:key}));},
 };
}
export function retainedBackupIds(rows:Array<{id:string;createdAt:number}>,now:number){
 const sorted=[...rows].sort((a,b)=>b.createdAt-a.createdAt||b.id.localeCompare(a.id)),keep=new Set(sorted.slice(0,48).map(row=>row.id)),days=new Set<string>();
 for(const row of sorted){if(row.createdAt<now-30*86400000)continue;const day=new Date(row.createdAt).toISOString().slice(0,10);if(!days.has(day)){days.add(day);keep.add(row.id);}}
 return keep;
}
