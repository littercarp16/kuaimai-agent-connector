import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, symlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureNpmRuntime, PACKAGE } from '../../src/headless/npm-runtime.mjs';
test('npm 固定版本私有安装、忽略安装脚本、重复复用且不覆盖未知目录', async t => {
  const root=await mkdtemp('/private/tmp/km-npm-unit-');t.after(()=>rm(root,{recursive:true,force:true}));let calls=0;
  const run=async(command,args)=>{
    calls++;assert.equal(command,'npm');assert.ok(args.includes('--ignore-scripts'));assert.ok(args.includes('--registry=https://registry.npmjs.org'));assert.equal(args.at(-1),'kuaimai-agent-connector@0.3.2');
    const directory=join(args[args.indexOf('--prefix')+1],'node_modules',PACKAGE);await mkdir(directory,{recursive:true});await writeFile(join(directory,'package.json'),JSON.stringify({name:PACKAGE,version:'0.3.2'}));
  };
  const first=await ensureNpmRuntime({root,run});assert.equal(await ensureNpmRuntime({root,run}),first);assert.equal(calls,1);
  await rm(join(root,'npm/0.3.2'),{recursive:true});await symlink(root,join(root,'npm/0.3.2'));await assert.rejects(ensureNpmRuntime({root,run}),/路径无效/);assert.equal(calls,1);
});
test('发布 tarball 从 npm 安装依赖后可独立后台运行', {skip:!process.env.KM_NPM_TARBALL,timeout:180000}, async t => {
  const root=await mkdtemp('/private/tmp/km-npm-package-');let runtime,directory;
  t.after(async()=>{if(runtime)await runtime.control(directory,{action:'stop'}).catch(()=>{});await delay(300);await rm(root,{recursive:true,force:true});});
  const installed=await ensureNpmRuntime({root,spec:process.env.KM_NPM_TARBALL});
  const {installExtensionHost}=await import(pathToFileURL(join(installed,'src/extension/install.mjs')));
  const browser=await installExtensionHost({directory:join(root,'browser'),profiles:[join(root,'chrome-test-profile')]});
  assert.equal(JSON.parse(await readFile(join(browser.extensionDirectory,'manifest.json'))).permissions[0],'nativeMessaging');
  assert.ok((await readFile(join(root,'browser/native-host'),'utf8')).includes(join(installed,'native-host.mjs')));
  const {stdout}=await promisify(execFile)(join(root,'npm/0.3.2/node_modules/.bin/kuaimai-agent'),['--version']);assert.equal(stdout.trim(),'0.3.2');
  runtime=await import(pathToFileURL(join(installed,'src/headless/service.mjs')));directory=join(root,'instance');
  const started=await runtime.ensureService({origin:'https://app.ltpass.com',directory});assert.equal(started.loginStartup,false);
  const health=await(await fetch(started.endpoint+'/v1/health',{headers:{Origin:'https://app.ltpass.com','X-Km-Agent':'1'}})).json();assert.equal(health.ok,true);assert.equal(health.data.capabilities.projectIndependentSessions,true);assert.equal(health.data.capabilities.codexDesktopDockPersistence,false);
  assert.equal((await runtime.ensureService({origin:'https://app.ltpass.com',directory})).pid,started.pid);
});
