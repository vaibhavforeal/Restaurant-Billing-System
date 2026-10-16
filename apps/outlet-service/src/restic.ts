import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {isAbsolute,resolve,basename,dirname} from 'node:path';
import {verifyBackup} from '../../server/src/backups.js';
const execute=promisify(execFile);
export type ResticConfig={repository:string;passwordFile:string;executable?:string};
type Runner=(binary:string,args:string[],cwd:string)=>Promise<string>;
export async function backupWithRestic(snapshot:string,config:ResticConfig,run:Runner=async(binary,args,cwd)=>{
 const result=await execute(binary,args,{cwd,windowsHide:true,maxBuffer:8*1024*1024});return result.stdout;
}){
 const source=resolve(snapshot);verifyBackup(source);
 if(!isAbsolute(config.repository)||!isAbsolute(config.passwordFile))throw new Error('Use absolute repository and password-file paths');
 const output=await run(config.executable??'restic',['--repo',config.repository,'--password-file',config.passwordFile,'backup','--json','--tag','forkflow-verified-sqlite','--',basename(source)],dirname(source));
 const summary=output.trim().split(/\r?\n/).map(line=>JSON.parse(line)).find(row=>row.message_type==='summary');
 if(!summary?.snapshot_id)throw new Error('Restic did not confirm a saved snapshot');
 return{snapshotId:String(summary.snapshot_id),source};
}
