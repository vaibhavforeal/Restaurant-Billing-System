import {expect,it,vi} from 'vitest';
import {startCloud} from './main.js';

it('validates the database before listening and closes it on shutdown',async()=>{
 const calls:string[]=[];
 const pool={end:vi.fn(async()=>{calls.push('end');})};
 const app={listen:vi.fn(async()=>{calls.push('listen');}),close:vi.fn(async()=>{calls.push('close');})};
 const env={DATABASE_URL:'postgresql://app:password@localhost/cloud',PORTAL_ORIGIN:'http://localhost:4300',CLOUD_COOKIE_INSECURE:'true',MAIL_DELIVERY_URL:'http://localhost:4500/deliver',MAIL_DELIVERY_TOKEN:'test',S3_REGION:'local',S3_BUCKET:'test',S3_ACCESS_KEY_ID:'test',S3_SECRET_ACCESS_KEY:'test'};
 const running=await startCloud(env,{pool:()=>pool as any,validate:async()=>{calls.push('validate');},api:async()=>app as any});
 expect(calls).toEqual(['validate','listen']);
 await running.close();await running.close();
 expect(calls).toEqual(['validate','listen','close','end']);
});

it('releases the database when startup validation fails',async()=>{
 const end=vi.fn(async()=>{}),api=vi.fn();
 const env={DATABASE_URL:'postgresql://app:password@localhost/cloud',PORTAL_ORIGIN:'http://localhost:4300',MAIL_DELIVERY_URL:'http://localhost:4500/deliver',MAIL_DELIVERY_TOKEN:'test',S3_REGION:'local',S3_BUCKET:'test',S3_ACCESS_KEY_ID:'test',S3_SECRET_ACCESS_KEY:'test'};
 await expect(startCloud(env,{pool:()=>({end}) as any,validate:async()=>{throw new Error('unsafe database');},api})).rejects.toThrow('unsafe database');
 expect(end).toHaveBeenCalledOnce();expect(api).not.toHaveBeenCalled();
});
