import {ApiError} from './db.js';
export function subscriptionBridge(baseUrl:string,serviceToken:string,transport:typeof fetch=fetch){
 const base=new URL(baseUrl);if(base.protocol!=='https:'&&base.hostname!=='localhost'&&base.hostname!=='127.0.0.1')throw new Error('Licensing service requires HTTPS');
 return{async create(installationId:string,plan:'basic'|'pro',period:'monthly'|'yearly'){
  const response=await transport(new URL('/v1/cloud/subscribe-session',base),{method:'POST',headers:{authorization:`Bearer ${serviceToken}`,'content-type':'application/json'},body:JSON.stringify({installationId}),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new ApiError(502,'Subscription service unavailable');const body=await response.json() as {session?:string};if(!body.session||!/^[A-Za-z0-9_-]{43}$/.test(body.session))throw new ApiError(502,'Invalid checkout session');
  const url=new URL('/subscribe',base);url.searchParams.set('session',body.session);url.searchParams.set('plan',plan);url.searchParams.set('period',period);return{url:url.href};
 }};
}
