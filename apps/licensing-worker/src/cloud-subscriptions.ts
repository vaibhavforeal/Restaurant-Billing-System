import {z} from 'zod';
import type {D1Like} from './env.js';
import {sha256Hex} from './secret.js';
import {getInstallation,deleteExpiredSessionsStatement,insertSessionStatement} from './store.js';
import {SESSION_TTL_MS} from './sessions.js';
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
export async function handleCloudSubscriptionSession(deps:{db:D1Like;now:()=>number},body:unknown,authorization:string|null,serviceToken:string|undefined){
 if(!serviceToken||serviceToken.length<32)return json({error:'service_unavailable'},503);
 // Fixed-size digest comparison avoids leaking prefix matches of the service credential.
 const expected=await sha256Hex(`Bearer ${serviceToken}`),actual=await sha256Hex(authorization??'');let difference=0;
 for(let index=0;index<expected.length;index++)difference|=expected.charCodeAt(index)^actual.charCodeAt(index);
 if(difference!==0)return json({error:'unauthorized'},401);
 const parsed=z.object({installationId:z.string().uuid()}).strict().safeParse(body);if(!parsed.success)return json({error:'bad_request'},400);
 if(!await getInstallation(deps.db,parsed.data.installationId))return json({error:'unknown_installation'},404);
 const bytes=crypto.getRandomValues(new Uint8Array(32)),session=btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 const now=deps.now(),expiresAt=now+SESSION_TTL_MS;
 await deps.db.batch([deleteExpiredSessionsStatement(deps.db,parsed.data.installationId,now),insertSessionStatement(deps.db,{tokenHash:await sha256Hex(session),installationId:parsed.data.installationId,expiresAt,createdAt:now})]);return json({session,expiresAt});
}
