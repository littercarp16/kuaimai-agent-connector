import{test}from'node:test';import assert from'node:assert/strict';import{mkdtemp,writeFile,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
const api=await import('../../src/runtime/publisher.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return{};});
test('发布命令只连接loopback；权限过宽的凭据文件不得读取或输出',async t=>{
 assert.equal(typeof api.readRuntime,'function','需要本地Agent发布通道');const dir=await mkdtemp(join(tmpdir(),'km-agent-pub-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'state.json');
 await writeFile(path,JSON.stringify({endpoint:'http://127.0.0.1:17653',key:'private',bindings:[]}),{mode:0o644});await assert.rejects(()=>api.readRuntime(path),/权限/);
 const safe=join(dir,'safe.json');await writeFile(safe,JSON.stringify({endpoint:'https://evil.example',key:'private',bindings:[]}),{mode:0o600});await assert.rejects(()=>api.readRuntime(safe),/loopback/);
});
test('新版指令不静默投递给旧连接器并丢弃语义',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'km-agent-version-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'state.json');await writeFile(path,JSON.stringify({endpoint:'http://127.0.0.1:17655',key:'private-publisher-test-key',bindings:[]}),{mode:0o600});const original=globalThis.fetch;globalThis.fetch=async()=>{throw Error('不应该发网');};t.after(()=>{globalThis.fetch=original;});await assert.rejects(()=>api.publishEvent({runtimePath:path,sessionId:'ses_a',event:{protocol:'km-agent/1',id:'new',type:'panel.open',payload:{mode:'side'}}}),/换版|协议/);
});
