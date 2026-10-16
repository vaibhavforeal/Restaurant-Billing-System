import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { desktopBuildConfig } from '../desktop-build-config.mjs';
import { payloadFiles, sha256, verifyRelease } from './release.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function validateBuildOptions(options) {
  if (!options.runtime) throw new Error('Pinned runtime artifact is required');
  if (!/^[a-f0-9]{64}$/i.test(options.runtimeSha256 ?? '')) throw new Error('Runtime SHA-256 must be explicit');
  if (!options.winsw || !/^[a-f0-9]{64}$/i.test(options.winswSha256 ?? '')) throw new Error('Pinned WinSW artifact and SHA-256 are required');
  if (!/^build\/outlet\/[a-z0-9][a-z0-9-]{0,63}$/.test(options.output ?? '')) throw new Error('Build output must be build/outlet/<safe-name>');
  if (!options.signingKeyFile || !options.licensePublicKeyFile) throw new Error('Release signing key and commercial license PUBLIC key files are required');
  if (options.winswVersion !== '2.12.0') throw new Error('This installer supports pinned WinSW 2.12.0 x64');
  if (!Number.isInteger(options.minSchema) || options.minSchema < 1) throw new Error('Minimum supported database schema is required');
  return options;
}
const xmlEscape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export function serviceXml(releaseDirectory, stateDirectory, version) {
  const bin = xmlEscape(releaseDirectory), state = xmlEscape(stateDirectory);
  return `<?xml version="1.0" encoding="UTF-8"?>
<service>
  <id>ForkFlowOutlet</id><name>ForkFlow Outlet</name><description>Local restaurant billing and printing service</description>
  <executable>${bin}\\node.exe</executable><arguments>"${bin}\\server\\main.mjs"</arguments>
  <workingdirectory>${bin}</workingdirectory><startmode>Automatic</startmode>
  <serviceaccount><domain>NT SERVICE</domain><user>ForkFlowOutlet</user><password></password><allowservicelogon>false</allowservicelogon></serviceaccount>
  <env name="FORKFLOW_RUNTIME" value="outlet-service"/><env name="FORKFLOW_HOST" value="127.0.0.1"/><env name="FORKFLOW_PORT" value="4100"/>
  <env name="FORKFLOW_DATA_DIR" value="${state}\\data"/><env name="FORKFLOW_UI_DIR" value="${bin}\\ui"/><env name="FORKFLOW_APP_VERSION" value="${xmlEscape(version)}"/>
  <env name="NODE_ENV" value="production"/>
  <env name="NODE_OPTIONS" value=""/>
  <onfailure action="restart" delay="10 sec"/><onfailure action="restart" delay="30 sec"/><onfailure action="restart" delay="60 sec"/><resetfailure>1 hour</resetfailure>
  <stoptimeout>45 sec</stoptimeout><stopparentprocessfirst>true</stopparentprocessfirst>
  <logpath>${state}\\logs</logpath><log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>8</keepFiles></log>
</service>
`;
}
export async function buildOutlet(options) {
  validateBuildOptions(options);
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build and native SQLite validation require Windows x64');
  for (const [file, checksum] of [[options.runtime, options.runtimeSha256], [options.winsw, options.winswSha256]]) {
    if (sha256(readFileSync(file)) !== checksum.toLowerCase()) throw new Error(`Pinned artifact checksum mismatch: ${file}`);
  }
  const runtimeMetadata = JSON.parse(execFileSync(resolve(options.runtime), ['-p', 'JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})'], { encoding: 'utf8', windowsHide: true }));
  if (!/^24\.\d+\.\d+$/.test(runtimeMetadata.version) || runtimeMetadata.platform !== 'win32' || runtimeMetadata.arch !== 'x64') throw new Error('Pinned Node artifact must be Node 24 Windows x64');
  const key = createPrivateKey(readFileSync(options.signingKeyFile));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Release signing key must be Ed25519');
  const releasePublicKey = createPublicKey(key).export({ type: 'spki', format: 'pem' });
  const commercial = desktopBuildConfig(['--commercial'], { FORKFLOW_LICENSE_PUBLIC_KEY: readFileSync(options.licensePublicKeyFile, 'utf8'), FORKFLOW_LICENSE_SERVICE_URL: options.licenseServiceUrl ?? '' });
  const stage = resolve(root, options.output);
  if (relative(root, stage).replaceAll('\\', '/') !== options.output || existsSync(stage)) throw new Error('Output must be new; existing artifacts are never overwritten');
  if (!existsSync(join(root, 'apps/ui/dist/index.html'))) throw new Error('Build UI first: npm run build -w @forkflow/ui');
  const version = options.version ?? JSON.parse(readFileSync(join(root, 'package.json'))).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Stable release version is required');
  mkdirSync(stage, { recursive: true });
  const installed = new Map();
  function locate(name, from) {
    const lookup = createRequire(join(from, 'package.json'));
    for (const directory of lookup.resolve.paths(`${name}/package.json`) ?? []) {
      const candidate = join(directory, name);
      if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    }
    throw new Error(`Missing locked dependency: ${name}`);
  }
  function copyDependency(name, from, parent = stage) {
    const source = locate(name, from), manifest = JSON.parse(readFileSync(join(source, 'package.json')));
    const top = join(stage, 'node_modules', name);
    const target = !installed.has(top) || installed.get(top) === source ? top : join(parent, 'node_modules', name);
    if (installed.get(target) === source) return manifest.version;
    installed.set(target, source);
    cpSync(source, target, { recursive: true, dereference: true, filter: path => !relative(source, path).split(/[\\/]/).includes('node_modules') });
    for (const dependency of Object.keys(manifest.dependencies ?? {})) copyDependency(dependency, source, target);
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
      try { locate(dependency, source); } catch { continue; }
      copyDependency(dependency, source, target);
    }
    return manifest.version;
  }
  const dependencyNames = Object.keys(JSON.parse(readFileSync(join(root, 'apps/server/package.json'))).dependencies).filter(name => !name.startsWith('@forkflow/'));
  const dependencies = Object.fromEntries([...dependencyNames, 'better-sqlite3'].map(name => [name, copyDependency(name, root)]));
  const define = { __FORKFLOW_LICENSE_PUBLIC_KEY__: JSON.stringify(commercial.publicKey), __FORKFLOW_LICENSE_SERVICE_URL__: JSON.stringify(commercial.serviceUrl), __FORKFLOW_COMMERCIAL__: 'true', __FORKFLOW_DEMO__: 'false' };
  const plugins = [{ name: 'workspace-source', setup(b) { b.onResolve({ filter: /^@forkflow\/(domain|core|contracts)(\/.*)?$/ }, args => {
    const [, workspace, subpath] = args.path.match(/^@forkflow\/(domain|core|contracts)(\/.*)?$/);
    return { path: join(root, 'packages', workspace, 'src', subpath ? subpath.slice(1) + '.ts' : 'index.ts') };
  }); } }];
  const common = { bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24', define, plugins };
  await build({ ...common, entryPoints: [join(root, 'apps/server/src/main.ts')], outfile: join(stage, 'server/main.mjs') });
  await build({ ...common, entryPoints: [join(root, 'apps/outlet-service/src/maintenance-cli.ts')], outfile: join(stage, 'maintenance.mjs') });
  cpSync(options.runtime, join(stage, 'node.exe')); cpSync(options.winsw, join(stage, 'ForkFlowOutlet.exe'));
  cpSync(join(root, 'apps/ui/dist'), join(stage, 'ui'), { recursive: true });
  for (const name of ['release.mjs', 'health.mjs', 'update.mjs', 'outlet.ps1', 'install.ps1', 'update.ps1', 'update-action.ps1', 'maintenance.ps1', 'uninstall.ps1', 'launch.ps1']) cpSync(join(root, 'tools/outlet', name), join(stage, name));
  cpSync(join(root, 'tools/setup-captain-https.ps1'), join(stage, 'setup-captain-https.ps1'));
  writeFileSync(join(stage, 'service-template.xml'), serviceXml('{RELEASE}', '{STATE}', version));
  writeFileSync(join(stage, 'release-public.pem'), releasePublicKey);
  writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: 'forkflow-outlet', version, private: true, type: 'module', dependencies }, null, 2));
  const schemaSource = join(stage, 'schema-info.mjs');
  await build({ ...common, stdin: { contents: 'import { MIGRATIONS } from "@forkflow/domain"; console.log(MIGRATIONS.at(-1).version);', resolveDir: root }, outfile: schemaSource });
  const schema = Number(execFileSync(join(stage, 'node.exe'), [schemaSource], { encoding: 'utf8', windowsHide: true }));
  if (!Number.isInteger(schema) || options.minSchema > schema) throw new Error('Invalid database compatibility range');
  // This executes the actual staged runtime and actual native SQLite package.
  execFileSync(join(stage, 'node.exe'), ['--input-type=module', '-e', 'import Database from "better-sqlite3"; const db=new Database(":memory:"); if(db.prepare("select 42 as n").get().n!==42) throw Error("SQLite smoke failed"); db.close();'], { cwd: stage, windowsHide: true });
  const files = Object.fromEntries(payloadFiles(stage).map(name => [name, sha256(readFileSync(join(stage, name)))]));
  const manifest = { format: 1, product: 'forkflow-outlet', edition: 'commercial', version, runtime: runtimeMetadata.version, platform: 'win32-x64', winsw: options.winswVersion, schema, minSchema: options.minSchema, files };
  const bytes = Buffer.from(JSON.stringify(manifest));
  writeFileSync(join(stage, 'release.json'), bytes); writeFileSync(join(stage, 'release.sig'), sign(null, bytes, key).toString('base64'));
  verifyRelease(stage, releasePublicKey);
  console.log(`Signed outlet bundle: ${stage}; Node ${runtimeMetadata.version}, SQLite validated, schema ${options.minSchema}..${schema}`);
  return stage;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] !== '--config' || !process.argv[3]) throw new Error('Usage: node tools/outlet/build.mjs --config <build-config.json>');
  await buildOutlet(JSON.parse(readFileSync(process.argv[3], 'utf8').replace(/^\uFEFF/, '')));
}
