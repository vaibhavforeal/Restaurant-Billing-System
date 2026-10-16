import {afterAll,beforeAll,expect,it} from 'vitest';
import {createServer,type Server} from 'node:http';
import {createHash} from 'node:crypto';
import {azureBlobStorage,azureEmailMailer} from './azure.js';

const bytes=Buffer.from('encrypted-backup-test');
const digest=createHash('sha256').update(bytes).digest('hex');
let server:Server,endpoint:string;
const requests:Array<{method:string;url:string;headers:Record<string,unknown>;body:string}>=[];
beforeAll(async()=>{
 server=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
  requests.push({method:req.method!,url:req.url!,headers:req.headers,body:Buffer.concat(chunks).toString()});
  res.setHeader('x-ms-request-id','test-request');
  if(req.url?.startsWith('/emails:send')){
   res.setHeader('operation-location',`${endpoint}/emails/operations/test-id`);
   res.writeHead(202);res.end(JSON.stringify({id:'test-id',status:'Running'}));return;
  }
  if(req.url?.startsWith('/emails/operations/')){
   res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'test-id',status:'Succeeded'}));return;
  }
  if(req.method==='HEAD'){res.setHeader('content-length',bytes.length);res.setHeader('etag','"verified-v1"');res.end();return;}
  if(req.method==='GET'){res.setHeader('content-length',bytes.length);res.setHeader('etag','"verified-v1"');res.end(bytes);return;}
  res.writeHead(req.method==='DELETE'?202:201);res.end();
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('No fixture port');
 endpoint=`http://127.0.0.1:${address.port}`;
});
afterAll(async()=>{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});
const storage=()=>azureBlobStorage({accountName:'testaccount',accountKey:Buffer.alloc(32,7).toString('base64'),container:'private',endpoint:`${endpoint}/testaccount`});

it('limits signed upload and download links to one blob and their intended operation',async()=>{
 const store=storage(),upload=await store.upload('staging/org/outlet/a',bytes.length,digest);
 const put=new URL(upload.uploadUrl),get=new URL(await store.download('objects/org/outlet/a'));
 expect(put.pathname).toBe('/testaccount/private/staging/org/outlet/a');
 expect(put.searchParams.get('sp')).toBe('c');expect(put.searchParams.get('sr')).toBe('b');expect(put.searchParams.get('spr')).toBe('https');
 expect(new Date(put.searchParams.get('se')!).getTime()-Date.now()).toBeLessThanOrEqual(900000);
 expect(upload.headers['x-ms-blob-type']).toBe('BlockBlob');expect(upload.headers['x-ms-meta-sha256']).toBe(digest);
 expect(get.pathname).toBe('/testaccount/private/objects/org/outlet/a');expect(get.searchParams.get('sp')).toBe('r');
 expect(new Date(get.searchParams.get('se')!).getTime()-Date.now()).toBeLessThanOrEqual(300000);
});
it('checks actual bytes under an ETag before promotion and rejects an incorrect checksum or length',async()=>{
 const store=storage();
 await expect(store.verify('staging/a',bytes.length,digest)).resolves.toEqual({etag:'"verified-v1"'});
 const read=requests.filter(request=>request.method==='GET').at(-1)!;
 expect(read.headers['if-match']).toBe('"verified-v1"');
 await expect(store.verify('staging/a',bytes.length,'0'.repeat(64))).rejects.toThrow(/checksum/);
 await expect(store.verify('staging/a',bytes.length+1,digest)).rejects.toThrow(/length/);
 await store.promote('staging/a','objects/a','"verified-v1"');
 const copy=requests.at(-1)!;
 expect(copy.headers['x-ms-source-if-match']).toBe('"verified-v1"');
 expect(new URL(String(copy.headers['x-ms-copy-source'])).pathname).toBe('/testaccount/private/staging/a');
 expect(copy.url.split('?')[0]).toBe('/testaccount/private/objects/a');
 await store.remove('staging/a');expect(requests.at(-1)?.method).toBe('DELETE');
});
it('submits an invitation link to Azure Email and waits for service acceptance',async()=>{
 const mailer=azureEmailMailer({endpoint,accessKey:Buffer.alloc(32,7).toString('base64'),sender:'DoNotReply@azurecomm.net'},'https://portal.example');
 await mailer.deliver({email:'owner@example.test',token:'secret-token',kind:'invite',expiresAt:Date.now()+60000});
 const request=requests.find(request=>request.url.startsWith('/emails:send'))!;
 const message=JSON.parse(request.body);
 expect(message.senderAddress).toBe('DoNotReply@azurecomm.net');expect(message.recipients.to).toEqual([{address:'owner@example.test'}]);
 expect(message.content.plainText).toContain('https://portal.example/invite?token=secret-token');
 expect(request.headers.authorization).toMatch(/^HMAC-SHA256 /);
 expect(requests.some(request=>request.url.startsWith('/emails/operations/'))).toBe(true);
});
