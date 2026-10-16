import {resolve,join} from 'node:path';
import {maintainOutlet} from '../../apps/outlet-service/src/maintenance.js';
import {backupWithRestic} from '../../apps/outlet-service/src/restic.js';
const [dataDir]=process.argv.slice(2);
const repository=process.env.RESTIC_REPOSITORY,passwordFile=process.env.RESTIC_PASSWORD_FILE;
if(!dataDir||!repository||!passwordFile)throw new Error('Usage: RESTIC_REPOSITORY and RESTIC_PASSWORD_FILE configured; npx tsx tools/outlet/restic.mts <data-dir>');
const data=resolve(dataDir),backup=await maintainOutlet(data,'backup');
console.log(JSON.stringify(await backupWithRestic(join(data,'backups',backup.backup!),{repository,passwordFile,executable:process.env.FORKFLOW_RESTIC_EXE}),null,2));
