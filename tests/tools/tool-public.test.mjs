import{test}from'node:test';import assert from'node:assert/strict';
const api=await import('../../src/tools/tool-public.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return{};});
import{createProjection}from'../../src/session/shared-state.mjs';
test('工具信息保留公开命令/文件/域名，隐藏密钥、请求体与URL凭据查询',()=>{
 assert.equal(typeof api.publicToolInfo,'function');
 assert.match(api.publicToolInfo('shell',{command:'git status --short'}).summary,/git status --short/);
 assert.match(api.publicToolInfo('read',{path:'/workspace/report.mjs',offset:10,limit:30}).summary,/report.mjs/);
 const command=api.publicToolInfo('shell',{command:'API_KEY=supersecret lingtong-cli --token verysecret --body \'{"password":"hidden"}\' table list'});
 assert.match(command.summary,/lingtong-cli/);assert.doesNotMatch(JSON.stringify(command),/supersecret|verysecret|hidden/);
 const web=api.publicToolInfo('webfetch',{url:'https://user:secret@example.com/docs?token=hiddentoken#private'});assert.match(web.summary,/example.com\/docs/);assert.doesNotMatch(JSON.stringify(web),/secret|hiddentoken|user:/);
 const protectedFile=api.publicToolInfo('read',{path:'/workspace/.env'});assert.doesNotMatch(protectedFile.summary,/\.env/);
});
test('活动投影展示公开工具摘要和分类错误，思考仅接受显式公开摘要',()=>{
 const p=createProjection('ses_test'),e=(type,data)=>p.accept({id:crypto.randomUUID(),type,data:{sessionID:'ses_test',...data}});
 e('session.tool.input.started',{id:'t',name:'read'});e('session.tool.called',{id:'t',publicTool:{summary:'report.mjs · 起始85行',detail:'读取文件范围'}});e('session.tool.failed',{id:'t',publicResult:{errorSummary:'起始行85超出文件77行',detail:'起始行85超出文件77行'}});
 assert.match(p.value.activities.find(a=>a.id==='tool:t').summary||'',/report.mjs/);assert.match(p.value.activities.find(a=>a.id==='tool:t').errorSummary||'',/85.*77/);
 p.publish({id:'public-think',type:'activity.updated',payload:{id:'thinking:public',kind:'thinking',label:'思考',status:'running',visibility:'public',publicSummary:'正在核对销售日期与退款口径'}});assert.match(p.value.activities.find(a=>a.id==='thinking:public').publicSummary||'',/销售日期/);
 e('session.reasoning.delta',{assistantMessageID:'msg_a',ordinal:0,delta:'PRIVATE_CHAIN'});assert.doesNotMatch(JSON.stringify(p.value),/PRIVATE_CHAIN/);
});
test('带引号的shell分隔符只是参数，不能让后续JSON成为公开命令',()=>{
 for(const symbol of ['|',';','&']){const info=api.publicToolInfo('shell',{command:`echo '${symbol}' '{"token":"REVIEW_SECRET"}'`});assert.doesNotMatch(JSON.stringify(info),/REVIEW_SECRET/);}
});
test('未标为公开的thinking摘要不得进入快照，包括通用summary字段',()=>{
 const p=createProjection('ses_test');p.publish({id:'bad-summary',type:'activity.updated',payload:{id:'thought',kind:'thinking',label:'思考',status:'running',summary:'PRIVATE_REVIEW_TEXT',detail:'PRIVATE_REVIEW_DETAIL',errorSummary:'PRIVATE_REVIEW_ERROR'}});assert.doesNotMatch(JSON.stringify(p.value),/PRIVATE_REVIEW/);
});
test('成功返回且executed:false时不能误报本地未执行，npm/Node普通参数可读',()=>{
 assert.doesNotMatch(api.publicToolResult('shell',{executed:false}).detail,/未执行/);assert.match(api.publicToolInfo('shell',{command:'npm run test:agent:ui'}).summary,/npm run test:agent:ui/);assert.match(api.publicToolInfo('shell',{command:'node --input-type=module example.mjs'}).summary,/module/);
});
test('思考详情关联同消息的公开回复或公开执行动作，不读取reasoning正文',()=>{
 const p=createProjection('ses_test'),e=(type,data)=>p.accept({id:crypto.randomUUID(),type,data:{sessionID:'ses_test',...data}});e('session.reasoning.started',{assistantMessageID:'msg_a',ordinal:0});e('session.reasoning.delta',{assistantMessageID:'msg_a',ordinal:0,delta:'PRIVATE_INTERNAL_TEXT'});e('session.tool.input.started',{assistantMessageID:'msg_a',id:'t',name:'read'});e('session.tool.called',{assistantMessageID:'msg_a',id:'t',publicTool:{summary:'report.mjs'}});assert.match(p.value.activities.find(a=>a.kind==='thinking').publicSummary||'',/report.mjs/);e('session.text.ended',{assistantMessageID:'msg_a',ordinal:1,text:'公开说明：正在核对订单日期和退款口径。'});const thought=p.value.activities.find(a=>a.kind==='thinking');assert.match(thought.publicSummary,/核对订单日期/);assert.equal(thought.publicSummarySource,'assistant-public-text');assert.doesNotMatch(JSON.stringify(p.value),/PRIVATE_INTERNAL_TEXT/);
});
test('附件消息投影只保留文件名和MIME，不把base64推到SSE',()=>{const p=createProjection('ses_test');p.accept({id:'files-event',type:'session.inbox.enqueued',data:{sessionID:'ses_test',inboxID:'msg_files',item:{type:'user',payload:{text:'附件',files:[{name:'测试.txt',mime:'text/plain',data:'PRIVATE_BASE64_DATA',source:{type:'inline'}}]},delivery:'queue'}}});assert.equal(p.value.messages[0].files?.[0]?.name,'测试.txt');assert.doesNotMatch(JSON.stringify(p.value),/PRIVATE_BASE64_DATA/);});
