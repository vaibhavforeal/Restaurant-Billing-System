import {build} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const output=resolve('build/cloud');
await mkdir(`${output}/migrations`,{recursive:true});
const result=await build({entryPoints:['apps/cloud-api/src/main.ts','apps/cloud-api/src/migrate.ts','apps/cloud-api/src/bootstrap-admin.ts'],outdir:`${output}/src`,bundle:true,platform:'node',format:'esm',target:'node24',banner:{js:"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"},outExtension:{'.js':'.mjs'},external:['pg','argon2','@aws-sdk/*','@azure/*'],metafile:true});
if(Object.keys(result.metafile.inputs).some(path=>/better-sqlite3|apps\/server|apps\/desktop/.test(path)))throw new Error('Cloud bundle imports outlet runtime code');
for(const name of ['001-platform.sql','002-storage.sql','003-runtime-access.sql'])await copyFile(`apps/cloud-api/migrations/${name}`,`${output}/migrations/${name}`);
console.log('Cloud API, migration and administrator entry points bundled without outlet runtime code.');
