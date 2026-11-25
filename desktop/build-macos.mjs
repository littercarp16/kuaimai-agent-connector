#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, readFile, writeFile, rm, readdir, lstat, chmod, realpath, symlink } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const run = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'darwin') throw Error('macOS application builds require macOS and Xcode Command Line Tools');
const args = process.argv.slice(2), opts = {};
for (let i=0;i<args.length;i++) { if (!['--out','--node','--identity','--notary-profile'].includes(args[i]) || !args[i+1]) throw Error('Expected --out, --node, --identity or --notary-profile');opts[args[i].slice(2)]=args[++i]; }
const out=resolve(opts.out||join(root,'dist/macos')),node=await realpath(opts.node||process.execPath),identity=opts.identity||'-';
const {stdout:archText}=await run(node,['-p','process.platform+":"+process.arch']);const [platform,arch]=archText.trim().split(':');
if(platform!=='darwin'||!['arm64','x64'].includes(arch))throw Error('A standalone macOS arm64 or x64 Node binary is required');
const {stdout:deps}=await run('/usr/bin/otool',['-L',node]);
if(deps.split('\n').slice(1).some(line=>line.trim()&&!line.trim().startsWith('/usr/lib/')&&!line.trim().startsWith('/System/Library/')))throw Error('Node must not depend on Homebrew or other external shared libraries');
const name='Kuaimai Agent Connector.app',app=join(out,name),resources=join(app,'Contents/Resources'),runtime=join(resources,'runtime');
await mkdir(out,{recursive:true});
try{const existing=await readFile(join(out,'.km-agent-build'),'utf8');if(existing.trim()!==root)throw Error('Foreign build directory');}
catch(error){if(error.code!=='ENOENT')throw error;if((await readdir(out)).length)throw Error('Output directory is not empty; choose a dedicated build directory');await writeFile(join(out,'.km-agent-build'),root+'\n');}
await rm(app,{recursive:true,force:true});await mkdir(join(app,'Contents/MacOS'),{recursive:true});await mkdir(join(resources,'bin'),{recursive:true});await mkdir(runtime,{recursive:true});
await cp(join(root,'desktop/macos/Info.plist'),join(app,'Contents/Info.plist'));await cp(join(root,'desktop/origins.json'),join(resources,'origins.json'));await cp(node,join(resources,'bin/node'));await chmod(join(resources,'bin/node'),0o755);
const directories=['src','web'];
for(const directory of directories)await cp(join(root,directory),join(runtime,directory),{recursive:true,filter:path=>!path.endsWith('.DS_Store')&&!/\.test\.mjs$/.test(path)});
await mkdir(join(runtime,'skills/km-agent-bridge/scripts'),{recursive:true});
await cp(join(root,'skills/km-agent-bridge/scripts/prepare.mjs'),join(runtime,'skills/km-agent-bridge/scripts/prepare.mjs'));
await mkdir(join(runtime,'desktop'),{recursive:true});await cp(join(root,'desktop/service.mjs'),join(runtime,'desktop/service.mjs'));
for(const file of ['package.json','package-lock.json','main.mjs','start.mjs','codex-desktop.mjs','publish.mjs','mcp-workbuddy.mjs'])await cp(join(root,file),join(runtime,file));
const nodeVersion=(await run(node,['--version'])).stdout.trim();
await mkdir(join(resources,'Licenses'),{recursive:true});
await cp(join(root,`desktop/licenses/Node-${nodeVersion}-LICENSE.txt`),join(resources,'Licenses/Node-LICENSE.txt'));
await cp(join(root,'node_modules'),join(runtime,'node_modules'),{recursive:true,dereference:true,filter:path=>!path.endsWith('.DS_Store')&&!path.includes('/.cache/')});
await run('/usr/bin/xcrun',['swiftc','-swift-version','5','-O','-target',`${arch==='x64'?'x86_64':'arm64'}-apple-macosx13.0`,'-module-cache-path',join(out,'.swift-cache'),'-framework','AppKit','-framework','ServiceManagement',join(root,'desktop/macos/App.swift'),'-o',join(app,'Contents/MacOS/KuaimaiAgentConnector')],{maxBuffer:1024*1024});
const signBase=['--force','--sign',identity,...(identity==='-'?[]:['--timestamp','--options','runtime'])];
await run('/usr/bin/codesign',[...signBase,'--entitlements',join(root,'desktop/macos/node-entitlements.plist'),join(resources,'bin/node')]);
await run('/usr/bin/codesign',[...signBase,app]);await run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
const zip=join(out,`Kuaimai-Agent-Connector-0.2.2-macOS-${arch}.zip`),dmg=join(out,`Kuaimai-Agent-Connector-0.2.2-macOS-${arch}.dmg`);
await rm(zip,{force:true});await run('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',app,zip]);
const staging=join(out,'.dmg-staging');await rm(staging,{recursive:true,force:true});await mkdir(staging);await cp(app,join(staging,name),{recursive:true});await symlink('/Applications',join(staging,'Applications'));
await writeFile(join(staging,'安装说明.txt'),'将 Kuaimai Agent Connector.app 拖入 Applications。\n打开后即可使用，菜单栏可管理后台服务与登录自启动。\n网页点击接入后，请在本机确认来源并保留连接窗口。\n');
await rm(dmg,{force:true});
await run('/usr/bin/hdiutil',['create','-volname','Kuaimai Agent Connector','-srcfolder',staging,'-ov','-format','UDZO',dmg],{maxBuffer:1024*1024});await rm(staging,{recursive:true,force:true});
if(opts['notary-profile']){
  if(identity==='-')throw Error('Notarization requires a Developer ID signing identity');
  await run('/usr/bin/xcrun',['notarytool','submit',dmg,'--keychain-profile',opts['notary-profile'],'--wait'],{timeout:600000,maxBuffer:1024*1024});
  await run('/usr/bin/xcrun',['stapler','staple',app]);await run('/usr/bin/xcrun',['stapler','staple',dmg]);
  await rm(zip,{force:true});await run('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',app,zip]);
}
const checksums=[];for(const file of [zip,dmg])checksums.push(createHash('sha256').update(await readFile(file)).digest('hex')+'  '+file.split('/').at(-1));
await writeFile(join(out,'SHA256SUMS'),checksums.join('\n')+'\n');
await writeFile(join(out,'build-info.json'),JSON.stringify({version:'0.2.2',arch,minMacOS:'13.0',node:(await run(node,['--version'])).stdout.trim(),signing:identity==='-'?'ad-hoc':'Developer ID',notarized:Boolean(opts['notary-profile'])},null,2)+'\n');
console.log(JSON.stringify({app,dmg,zip,arch,signed:identity!=='-',notarized:Boolean(opts['notary-profile'])}));
