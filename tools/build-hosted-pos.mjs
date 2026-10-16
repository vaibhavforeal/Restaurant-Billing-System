import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
await build({entryPoints:['apps/server/src/main.ts'],outfile:'build/hosted-pos/server/main.mjs',bundle:true,packages:'external',platform:'node',format:'esm',target:'node24',
 plugins:[{name:'workspace-source',setup(builder){builder.onResolve({filter:/^@forkflow\/(domain|core|contracts)(\/.*)?$/},args=>{const [,pkg,...subpath]=args.path.split('/');return {path:fileURLToPath(new URL(`../packages/${pkg}/src/${subpath.length?subpath.join('/'):'index'}.ts`,import.meta.url))};});}}]});
console.log('Hosted POS server bundled; restaurant UI is built separately with the existing Vite configuration.');
