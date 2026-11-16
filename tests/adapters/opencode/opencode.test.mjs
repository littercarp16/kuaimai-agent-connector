import { test } from 'node:test';
import assert from 'node:assert/strict';
const module=await import('../../../src/adapters/opencode/opencode.mjs').catch(error=>{if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;return {};});

test('OpenCode 专用会话拒绝所有工具，浏览器不能选择任意目录或既有会话',async()=>{
  assert.equal(typeof module.createOpenCodeAdapter,'function','需要真实 OpenCode 适配器');
  let createInput,promptInput;
  const client={server:{info:async options=>{assert.ok(options?.signal instanceof AbortSignal,'状态探测必须传递超时信号');return{version:'2.0.30'};}},session:{create:async input=>{createInput=input;return{id:'ses_test'};},get:async()=>({time:{created:1,updated:1}}),prompt:async input=>{promptInput=input;return{id:'inbox_test'};}}};
  const adapter=module.createOpenCodeAdapter({discover:async()=>({url:'http://127.0.0.1:4096'}),makeClient:()=>client,headers:()=>({}),directory:'/fixed/workspace'});
  assert.equal((await adapter.health()).ready,true);
  const id=await adapter.createSession();assert.equal(id,'ses_test');
  assert.deepEqual(createInput.permissions,[{action:'*',resource:'*',effect:'deny'}]);
  assert.equal(createInput.location.directory,'/fixed/workspace');
  await adapter.send(id,'生成商品分析预览');assert.match(promptInput.text,/kmmdtable/);
  await assert.rejects(()=>adapter.send('ses_someone_else','x'),/专用会话/);
});
test('快照仅输出可公开文本，不转发 reasoning、工具参数或工具输出',async()=>{
  assert.equal(typeof module.createOpenCodeAdapter,'function');
  let idle=1;
  const client={server:{info:async()=>({version:'2.0.30'})},session:{create:async()=>({id:'ses_test'}),get:async()=>({time:{idle},outcome:'succeeded'}),prompt:async()=>({id:'input'})},message:{list:async()=>({data:[{id:'a',type:'assistant',time:{created:1},content:[{type:'reasoning',text:'private-thought'},{type:'text',text:'公开说明'},{type:'tool',id:'t',name:'bash',state:{status:'completed',input:{token:'secret'},content:[{type:'text',text:'sensitive-output'}]}}]}],cursor:{}})}};
  const adapter=module.createOpenCodeAdapter({discover:async()=>({url:'http://127.0.0.1:4096'}),makeClient:()=>client,headers:()=>({}),directory:'/fixed'});
  await adapter.health();const id=await adapter.createSession();await adapter.send(id,'x');idle=2;
  const result=await adapter.read(id);assert.equal(result.status,'completed');assert.equal(result.messages[0].text,'公开说明');
  assert.doesNotMatch(JSON.stringify(result),/private-thought|secret|sensitive-output/);
});
test('用户消息按原顺序投影，不将接入协议混入聊天或当作成果执行',async()=>{
  let sent;
  const client={server:{info:async()=>({version:'2.0.30'})},session:{create:async()=>({id:'ses_test'}),get:async()=>({time:{}}),prompt:async input=>{sent=input.text;}},message:{list:async()=>({data:[{id:'assistant',type:'assistant',content:[{type:'text',text:'方案说明'}]},{id:'user',type:'user',text:sent}],cursor:{}})}};
  const adapter=module.createOpenCodeAdapter({discover:async()=>({url:'http://127.0.0.1:4096'}),makeClient:()=>client,headers:()=>({}),directory:'/fixed'});
  await adapter.health();const id=await adapter.createSession();await adapter.send(id,'只要商品表');
  const result=await adapter.read(id);assert.equal(result.messages[0].role,'user');assert.equal(result.messages[0].text,'只要商品表');assert.equal(result.messages[1].role,'assistant');
});
test('预检未结束时撤销请求，迟到的session.get不能继续派发prompt',async()=>{
  let release,prompts=0;
  const client={server:{info:async()=>({version:'2.0.30'})},session:{create:async()=>({id:'ses_owned'}),get:()=>new Promise(r=>{release=r;}),prompt:async()=>{prompts++;}}};
  const adapter=module.createOpenCodeAdapter({discover:async()=>({url:'http://127.0.0.1:4096'}),makeClient:()=>client,headers:()=>({}),directory:'/fixed'});
  await adapter.health();const id=await adapter.createSession(),controller=new AbortController();
  const sending=adapter.send(id,'x',{signal:controller.signal});controller.abort();release({time:{}});
  await sending.catch(()=>{});assert.equal(prompts,0);
});
