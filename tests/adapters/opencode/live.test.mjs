import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createOpenCodeAdapter } from '../../../src/adapters/opencode/opencode.mjs';
import '../../../src/protocol/model.js';

test('真实 OpenCode V2：独立会话只生成一张表的结构预览，不调用工具', {skip:process.env.KM_AGENT_LIVE!=='1',timeout:180000},async t=>{
  const adapter=createOpenCodeAdapter();
  assert.equal((await adapter.health()).ready,true,'需要已运行并登录模型的本地 OpenCode 服务');
  const session=await adapter.createSession();let finished=false;
  t.after(async()=>{if(!finished)await adapter.interrupt(session).catch(()=>{});});
  await adapter.send(session,'联调验证：只生成一张商品表，名称为“联调商品预览”，仅包含“商品编码”和“销量”两个字段、2条模拟数据。必须先输出一个plan协议块，再输出一个artifact协议块。不要其他页面，不要调用工具，不要读取文件。');
  const deadline=Date.now()+150000;let result;
  while(Date.now()<deadline){result=await adapter.read(session);if(result.status!=='running')break;await delay(1000);}
  assert.equal(result.status,'completed','真实模型必须确认结束，而不是仅收到请求回执');
  const parsed=globalThis.KmAgentModel.parseOutput(result.messages.map(x=>x.text).join('\n'));
  assert.equal(parsed.artifacts.length,1);assert.equal(parsed.artifacts[0].kind,'table');assert.equal(parsed.artifacts[0].rows.length,2);
  assert.equal(result.tools.length,0,'专用预览会话不应调用工具');
  finished=true;
  console.log('真实联调通过：本地OpenCode完成专用会话，生成1张表的2条模拟数据；没有工具调用或平台写入。');
});
