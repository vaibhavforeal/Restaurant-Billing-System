import {it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {backupWithRestic} from './restic.js';

it('rejects an invalid snapshot before invoking restic',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'forkflow-restic-invalid-'));
 const source=join(folder,'snapshot.db');writeFileSync(source,'invalid database');
 let called=false;
 try{
  await expect(backupWithRestic(source,{repository:join(folder,'repository'),passwordFile:join(folder,'password')},async()=>{called=true;return '';})).rejects.toThrow();
  expect(called).toBe(false);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
