import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {readRuntimeConfig} from '../apps/cloud-api/src/runtime.js';
import {azureBlobStorage} from '../apps/cloud-api/src/azure.js';
import {s3Storage} from '../apps/cloud-api/src/storage.js';

const config=readRuntimeConfig(process.env),store=config.storage.provider==='azure'?azureBlobStorage(config.storage):s3Storage(config.storage);
const bytes=Buffer.from(`ForkFlow storage verification ${randomUUID()}`),sha256=createHash('sha256').update(bytes).digest('hex');
const source=`verification/staging/${randomUUID()}`,target=`verification/objects/${randomUUID()}`;
try{
 const ticket=await store.upload(source,bytes.length,sha256);
 const upload=await fetch(ticket.uploadUrl,{method:'PUT',body:bytes,headers:ticket.headers});assert.ok(upload.ok,`Storage upload failed: ${upload.status}`);
 const verified=await store.verify(source,bytes.length,sha256);
 await assert.rejects(store.verify(source,bytes.length,'0'.repeat(64)),/checksum/);
 await store.promote(source,target,verified.etag);
 const link=await store.download(target),download=await fetch(link);assert.ok(download.ok,`Storage download failed: ${download.status}`);
 assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
 const unsigned=new URL(link);unsigned.search='';const denied=await fetch(unsigned);assert.ok(!denied.ok,'Private storage allowed anonymous reads');
 console.log('Private storage upload, actual checksum rejection, promotion, signed download and anonymous-read denial verified.');
}finally{await store.remove(source);await store.remove(target);}
console.log('Verification objects deleted.');
