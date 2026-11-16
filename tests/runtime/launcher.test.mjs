import{test}from'node:test';import assert from'node:assert/strict';
const api=await import('../../src/runtime/launch-options.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return{};});
test('启动参数明确受信来源/会话/适配能力，默认不授予网页控制',()=>{
 assert.equal(typeof api.parseLaunchOptions,'function');const result=api.parseLaunchOptions(['--adapter','generic','--session','ses_codex','--trust-origin','http://127.0.0.1:4173']);assert.equal(result.allowControl,false);assert.equal(result.adapter,'generic');assert.throws(()=>api.parseLaunchOptions(['--adapter','codex']),/适配器/);assert.throws(()=>api.parseLaunchOptions(['--trust-origin','https://evil.example','--session','ses_a']),/来源/);assert.throws(()=>api.parseLaunchOptions(['--adapter','generic','--allow-control']),/控制|会话/);
});
test('受控验收端口可显式指定，不扫描或写默认连接器状态',()=>{const result=api.parseLaunchOptions(['--adapter','generic','--session','ses_test','--trust-origin','http://127.0.0.1:4173','--port','17654']);assert.equal(result.port,17654);assert.throws(()=>api.parseLaunchOptions(['--port','0']),/端口/);});
test('原生自动跟随默认启用，可显式固定启动会话',()=>{assert.equal(api.parseLaunchOptions([]).followSessions,true);assert.equal(api.parseLaunchOptions(['--pin-session']).followSessions,false);});
