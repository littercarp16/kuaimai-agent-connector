#!/usr/bin/env node
// Explicit developer release step, not a command run by the customer's Agent.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),front=process.argv[2]&&resolve(process.argv[2]);
if(!front)throw Error('用法：node desktop/sync-code.mjs /lingtong-app-view/绝对路径');
const vendor=join(front,'src/views/kmMDTable/agent/vendor'),assets=join(front,'public/agent');
await mkdir(assets,{recursive:true});
for(const name of ['desktop-connect.js','code-connect.js']){
 let source=(await readFile(join(root,'web',name),'utf8')).replace('(() => {\n','');
 source=name==='desktop-connect.js'?source.replace('globalThis.KmDesktopConnector=Object.freeze({connect,challengeFor:sha256,randomUUID});\n})();','export default Object.freeze({connect,challengeFor:sha256,randomUUID});'):
 "import DesktopConnector from './desktop-connect'\n"+source.replaceAll('globalThis.KmDesktopConnector','DesktopConnector').replace('globalThis.KmCodeConnector = Object.freeze({ create });\n})();','export default Object.freeze({ create });');
 await writeFile(join(vendor,name),source);
}
for(const name of ['connect-callback.js','connect-callback.html'])await copyFile(join(root,'web',name),join(assets,name));
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
await writeFile(join(vendor,'code-release.json'),JSON.stringify({name:pkg.name,version:pkg.version,registry:pkg.publishConfig.registry},null,2)+'\n');
console.log('已同步 npm 版本、回调和网页 SDK');
