import{test}from'node:test';import assert from'node:assert/strict';
const api=await import('../../src/tools/tool-details.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return{};});
test('普通请求与真实返回可读，敏感字段遮蔽而不是整段替换成固定话术',()=>{
 assert.equal(typeof api.makeToolDetail,'function');const d=api.makeToolDetail({toolId:'t',name:'shell',input:{command:'npm run test:agent'},content:[{type:'text',text:'TAP version 13\n# tests 76\n# pass 76\nAPI_TOKEN=secret_value\nAuthorization: Bearer private_bearer'}],status:'completed',executed:false});
 assert.match(d.request.text,/npm run test:agent/);assert.match(d.result.text,/# pass 76/);assert.doesNotMatch(JSON.stringify(d),/secret_value|private_bearer|本地未执行/);assert.equal(d.status,'completed');assert.equal(d.result.available,true);
});
test('JSON嵌套秘密、URL凭据、PEM与超长内容安全处理，先脱敏再截断',()=>{
 assert.equal(typeof api.makeToolDetail,'function');const d=api.makeToolDetail({toolId:'t',name:'read',input:{path:'/workspace/report.json'},content:[{type:'text',text:JSON.stringify({ok:true,rows:3,nested:{access_token:'ABC_SECRET',password:'PASS_SECRET'},url:'https://u:URL_SECRET@example.com/a?token=QUERY_SECRET'})}],status:'completed'});
 assert.match(d.result.text,/rows/);assert.doesNotMatch(d.result.text,/ABC_SECRET|PASS_SECRET|URL_SECRET|QUERY_SECRET/);
 const huge=api.makeToolDetail({toolId:'big',name:'shell',input:{command:'npm test'},content:[{type:'text',text:'正常结果\n'.repeat(2500)+'password=TAIL_SECRET'}],status:'completed'});assert.equal(huge.result.truncated,true);assert.ok(huge.result.text.length<=12000);assert.doesNotMatch(huge.result.text,/TAIL_SECRET/);
 const pem=api.makeToolDetail({toolId:'pem',name:'shell',input:{command:'npm test'},content:[{type:'text',text:'-----BEGIN PRIVATE KEY-----\nPRIVATE_MATERIAL\n-----END PRIVATE KEY-----'}],status:'completed'});assert.doesNotMatch(pem.result.text,/PRIVATE_MATERIAL/);
});
test('受保护目标、未知工具与未返回状态有准确原因，不伪装成功或未执行',()=>{
 assert.equal(typeof api.makeToolDetail,'function');for(const path of ['/workspace/.env','/workspace/agent-connector/.runtime/connector.json']){const d=api.makeToolDetail({toolId:'p',name:'read',input:{path},content:[{type:'text',text:'NEVER_LEAK_ME'}],status:'completed'});assert.equal(d.result.available,false);assert.doesNotMatch(JSON.stringify(d),/NEVER_LEAK_ME/);assert.match(d.result.reason,/保护/);}
 const unknown=api.makeToolDetail({toolId:'x',name:'unknown-mcp',input:{token:'TOKEN'},content:[{type:'text',text:'UNKNOWN_SECRET'}],status:'completed'});assert.equal(unknown.result.available,false);assert.doesNotMatch(JSON.stringify(unknown),/UNKNOWN_SECRET|TOKEN/);
 const pending=api.makeToolDetail({toolId:'wait',name:'shell',input:{command:'git status --short'},status:'running'});assert.match(pending.result.reason,/尚未返回/);
});
test('详情存储有限、按会话隔离，并且只返回副本',()=>{
 assert.equal(typeof api.createDetailStore,'function');const store=api.createDetailStore({maxEntries:2});store.put('ses_a','t',{text:'A'});store.put('ses_b','t',{text:'B'});const a=store.get('ses_a','t');a.text='changed';assert.equal(store.get('ses_a','t').text,'A');assert.equal(store.get('ses_b','t').text,'B');store.put('ses_c','t',{text:'C'});assert.equal(store.get('ses_a','t'),null);
});
test('shell相对/带引号/管道目标与受保护工作目录都拒绝正文',()=>{
 for(const input of [{command:'cat .env'},{command:'cat "/workspace/.env"'},{command:'cat /workspace/.env | head'},{command:'cat connector.json',workdir:'/workspace/.runtime'}]){const d=api.makeToolDetail({toolId:'t',name:'shell',input,content:[{type:'text',text:'SENSITIVE_OUTPUT'}],status:'completed'});assert.equal(d.result.available,false,JSON.stringify(input));assert.doesNotMatch(JSON.stringify(d),/SENSITIVE_OUTPUT/);}
});
test('凭据配置和技能资源不能经read/grep/patch/shell绕过保护',()=>{
 const paths=['/home/example/.local/share/opencode/auth.json','/workspace/.agents/skills/example/SKILL.md','/home/example/.codex/auth.json','/workspace/.opencode/skills/example/references/private.md'];for(const path of paths)for(const[name,input]of [['read',{path}],['grep',{path}],['patch',{patchText:'*** Begin Patch\n*** Update File: '+path+'\n+x\n*** End Patch'}],['shell',{command:'cat "'+path+'"'}]]){const d=api.makeToolDetail({toolId:'t',name,input,content:[{type:'text',text:'{"key":"CREDENTIAL_OR_SKILL_SECRET"}'}],status:'completed'});assert.equal(d.result.available,false,name+':'+path);assert.doesNotMatch(JSON.stringify(d),/CREDENTIAL_OR_SKILL_SECRET/);}
});
test('未知工具不能通过名字后缀继承原生工具详情权限',()=>{
 for(const name of ['custom.read','custom.shell']){const d=api.makeToolDetail({toolId:'t',name,input:{path:'/workspace/report.txt',command:'npm test'},content:[{type:'text',text:'UNKNOWN_RESULT_SECRET'}],status:'completed'});assert.equal(d.result.available,false);assert.doesNotMatch(JSON.stringify(d),/UNKNOWN_RESULT_SECRET/);}
});
test('所有连接URL的userinfo密码都脱敏，不限HTTP协议',()=>{
 for(const scheme of ['postgresql','redis','mongodb','mongodb+srv','mysql','amqp'])for(const output of [`${scheme}://alice:CONNECTION_PASSWORD@localhost/report`,JSON.stringify({connection:`${scheme}://alice:CONNECTION_PASSWORD@localhost/report`})]){const d=api.makeToolDetail({toolId:'t',name:'shell',input:{command:'npm test'},content:[{type:'text',text:output}],status:'completed'});assert.doesNotMatch(d.result.text,/CONNECTION_PASSWORD|alice:/);}
});
test('仅格式化普通JSON不会误报敏感字段被遮蔽',()=>{const d=api.makeToolDetail({toolId:'t',name:'shell',input:{command:'npm test'},content:[{type:'text',text:'{"ok":true,"rows":3}\n'}],status:'completed'});assert.equal(d.result.redacted,false);});
