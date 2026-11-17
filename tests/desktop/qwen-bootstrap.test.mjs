import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {runService,connectService,decodeRequest} from '../../src/headless/service.mjs';
import {createQwenDesktopManager} from '../../src/runtime/qwen-desktop.mjs';
import {challengeFor} from '../../src/desktop/connect-grants.mjs';
test('CLI request routes Qwen preparation inside an existing background bridge; Codex request cannot start it',async t=>{
 const origin='http://local.lt.com:8251',directory=await mkdtemp('/private/tmp/km-qwen-boot-');let inspections=0;
 const manager=createQwenDesktopManager({runtime:{check:async()=>{},inspect:async()=>{inspections++;return{available:true,authenticated:true};}}});
 const service=await runService({origin,directory,qwenDesktopFactory:()=>manager});t.after(async()=>{await service.stop();await rm(directory,{recursive:true,force:true});});
 const request=provider=>Buffer.from(JSON.stringify({url:'km-agent://connect?'+new URLSearchParams({origin,callback:origin+'/agent/connect-callback.html',state:randomBytes(32).toString('base64url'),challenge:challengeFor(randomBytes(32).toString('base64url')),browser:'default',transport:'direct',provider}),created:Date.now()})).toString('base64url');
 await connectService(request('codex'),{directory});assert.equal(inspections,0);assert.equal(manager.status().state,'idle');
 const first=await connectService(request('qwen'),{directory});assert.equal(first.reused,true);assert.equal(first.preparation.state,'running');
 while(manager.status().state==='running')await new Promise(r=>setTimeout(r,10));assert.equal(inspections,1);
 await connectService(request('qwen'),{directory});while(manager.status().state==='running')await new Promise(r=>setTimeout(r,10));assert.equal(inspections,2);
 assert.throws(()=>decodeRequest(request('arbitrary')));
});
