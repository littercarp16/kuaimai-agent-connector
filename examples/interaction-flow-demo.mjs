/* Visible km-agent/1 walkthrough. UI previews + fixed sample data only; no model/business calls. */
import{mkdir,writeFile}from'node:fs/promises';
import{execFile}from'node:child_process';
import{promisify}from'node:util';
import{fileURLToPath}from'node:url';
import{setTimeout as delay}from'node:timers/promises';
import assert from'node:assert/strict';
import{createProjection}from'../src/session/shared-state.mjs';

const sessionId=process.argv[2];
if(!/^ses[\w-]+$/.test(sessionId||''))throw Error('需明确用户指定的已绑定会话ID；不向其他会话广播');
const sendOnly=process.argv.includes('--send-only');
const run='flow-'+Date.now().toString(36),page=run+'-page',table=run+'-table',task=run+'-task';
const root=new URL('../.runtime/'+run+'/',import.meta.url),publisher=fileURLToPath(new URL('../publish.mjs',import.meta.url)),exec=promisify(execFile);
const events=[];
function add(stage,type,payload,pause=1000){events.push({stage,pause,event:{protocol:'km-agent/1',id:run+'-'+String(events.length+1).padStart(2,'0'),type,payload}});}
const note='模拟数据 · 本地联调预览 · 未保存、未发布；不查询或修改业务数据。';

add('准备','plan.updated',{title:'AI全流程联调 · 模拟数据',items:[{id:page,kind:'page',name:'联调演示 · 销售概览'},{id:table,kind:'table',name:'联调演示 · 商品销售表'},{id:task,kind:'task',name:'联调演示 · 日报任务草案'}]},900);
add('准备','panel.open',{mode:'workspace'},1600);
add('准备','run.note',{text:'开始UI全流程联调：创建页面→分块填充→创建表格→分批追加→编辑→任务文本草案→模拟失败恢复→窗口收起与重开。全部使用固定模拟数据，仅本地预览，不保存或发布平台资源。'},900);
add('准备','activity.updated',{id:run+'-skill',kind:'skill',label:'技能 · km-agent-bridge',status:'completed',detail:'已实际加载桥接技能，读取协议并核对当前绑定与指令目录。'},700);

add('创建页面','step.updated',{id:run+'-page-step',label:'正在创建页面 · 联调演示',status:'running',detail:'建立本地未保存页面，再逐块填充。'},800);
add('创建页面','resource.create',{id:page,kind:'page',name:'联调演示 · 销售概览',appearance:{theme:'ink',accent:'#d6f36a',layout:'editorial'}},2200);
add('创建页面','work.status',{artifactId:page,status:'running',label:'正在创建页面：装配概览指标（联调预览）'},1800);
add('创建页面','artifact.updated',{id:page,kind:'page',name:'联调演示 · 销售概览',description:note,appearance:{theme:'ink',accent:'#d6f36a',layout:'editorial'},metrics:[{label:'模拟销售额',value:'¥128,600',hint:'固定样例，非真实订单'},{label:'模拟订单数',value:'386',hint:'固定样例'},{label:'模拟客单价',value:'¥333.16',hint:'128600 ÷ 386，四舍五入'},{label:'模拟同比',value:'+12.8%',hint:'仅视觉演示，不来自计算对比'}],chart:{type:'line',labels:['周一','周二','周三','周四','周五','周六','周日'],values:[12,16,15,22,19,25,31]},sections:[]},2200);
add('创建页面','page.section.updated',{artifactId:page,section:{id:'scope',title:'01 / 数据范围',text:'本页全部为固定模拟样例，趋势值仅用于界面演示。未读取订单、客户、库存或平台明细。'}},1600);
add('创建页面','page.section.updated',{artifactId:page,section:{id:'channels',title:'02 / 渠道观察',text:'模拟示例：渠道A约占58%，渠道B约占27%，其余约占15%。用于验证页面区块逐项出现。'}},1600);
add('创建页面','page.section.updated',{artifactId:page,section:{id:'advice',title:'03 / 经营建议 · 初稿',text:'模拟建议初稿：优先核对畅销商品库存。本区块稍后会被编辑指令定点更新。'}},1600);
add('创建页面','work.status',{artifactId:page,status:'completed',label:'页面联调预览已装配完成'},500);
add('创建页面','artifact.ready',{artifactId:page},1000);
add('创建页面','step.updated',{id:run+'-page-step',label:'页面预览已就绪 · 未保存',status:'completed',detail:'指标、趋势及三个说明区块已发送；是否展示以网页回执为准。'},900);

add('创建表格','step.updated',{id:run+'-table-step',label:'正在创建表格 · 联调演示',status:'running',detail:'先创建字段，再分两批填入模拟数据。'},800);
add('创建表格','resource.create',{id:table,kind:'table',name:'联调演示 · 商品销售表',appearance:{theme:'paper',accent:'#3b82f6',density:'comfortable'}},2200);
add('创建表格','work.status',{artifactId:table,status:'running',label:'正在创建表格：生成字段结构（联调预览）'},1600);
add('创建表格','artifact.updated',{id:table,kind:'table',name:'联调演示 · 商品销售表',description:note+' 可在预览内搜索和点击表头排序。',appearance:{theme:'paper',accent:'#3b82f6'},interactions:{search:true,sort:true},columns:['商品编码','模拟商品','渠道','销量','销售额','库存提示'],rows:[]},1800);
add('创建表格','table.rows.append',{artifactId:table,rows:[['DEMO-001','演示短袖','渠道A',120,11880,'模拟：库存充足'],['DEMO-002','演示衬衫','渠道B',86,12814,'模拟：待核对'],['DEMO-003','演示休闲裤','渠道A',72,13608,'模拟：库存充足']]},2200);
add('创建表格','work.status',{artifactId:table,status:'waiting',label:'等待下一批模拟行 · 当前3行（未查询业务接口）'},1800);
add('创建表格','table.rows.append',{artifactId:table,rows:[['DEMO-004','演示外套','渠道B',45,13455,'模拟：低库存'],['DEMO-005','演示运动鞋','渠道A',38,11362,'模拟：库存充足'],['DEMO-006','演示背包','其他',25,4975,'模拟：待核对']]},2200);
add('创建表格','work.status',{artifactId:table,status:'completed',label:'表格联调预览已装配：6字段、6行'},600);
add('创建表格','artifact.ready',{artifactId:table},1200);
add('创建表格','step.updated',{id:run+'-table-step',label:'表格预览已就绪 · 未建平台表',status:'completed',detail:'模拟行分两批发送，搜索与排序只作用于当前预览。'},1400);

add('编辑页面','resource.edit',{artifactId:page},1600);
add('编辑页面','work.status',{artifactId:page,status:'running',label:'正在编辑已有页面：更新经营建议（非新建）'},1600);
add('编辑页面','page.section.updated',{artifactId:page,section:{id:'advice',title:'03 / 经营建议 · 已更新',text:'模拟建议更新：先核对DEMO-004的低库存，再比对渠道A/B销量。此次按区块ID替换建议，数据范围与渠道观察两个区块保持不变。仅作联调，不构成真实经营建议。'}},2000);
add('编辑页面','artifact.ready',{artifactId:page},500);
add('编辑页面','work.status',{artifactId:page,status:'completed',label:'已有页面区块已更新 · 未保存'},900);

add('任务与恢复','run.note',{text:'下面演示任务草案及“模拟校验失败→恢复”状态。不会运行任务，不会调用真实失败接口；红色错误提示将明确标为模拟。'},900);
add('任务与恢复','resource.create',{id:task,kind:'task',name:'联调演示 · 日报任务草案',appearance:{theme:'forest',accent:'#66c2a5'}},1700);
add('任务与恢复','work.status',{artifactId:task,status:'running',label:'正在创建任务文本草案 · 不部署、不执行'},1000);
add('任务与恢复','artifact.updated',{id:task,kind:'task',name:'联调演示 · 日报任务草案',description:note+'脚本仅作文本展示，不执行。',appearance:{theme:'forest',accent:'#66c2a5'},code:'// 联调演示：尚未配置触发时间。\n// 仅文本草案，不执行；不读取数据。\nconst demoTask = { name: "模拟销售日报", schedule: null };'},1600);
add('任务与恢复','work.status',{artifactId:task,status:'failed',label:'模拟校验失败：触发时间未填写（非真实服务错误）'},2200);
add('任务与恢复','activity.updated',{id:run+'-recovery',kind:'phase',label:'演示失败恢复',status:'waiting',detail:'模拟条件：任务草案缺少触发时间。接下来只补齐示意文本，不执行任务。'},1400);
add('任务与恢复','work.status',{artifactId:task,status:'running',label:'模拟恢复中：补齐触发时间示意，不调用业务接口'},1200);
add('任务与恢复','artifact.updated',{id:task,kind:'task',name:'联调演示 · 日报任务草案',description:note+'恢复后的示意草案，未部署、未运行。',appearance:{theme:'forest',accent:'#66c2a5'},code:'// 联调演示 · 仅文本，不执行\n// 不读取订单，不写平台，不发送消息。\nconst demoTask = {\n  name: "模拟销售日报",\n  schedule: "每天 09:00（仅示意，未启用调度）",\n  input: "固定模拟数据",\n  output: "本地预览"\n};'},1600);
add('任务与恢复','artifact.ready',{artifactId:task},600);
add('任务与恢复','work.status',{artifactId:task,status:'completed',label:'模拟恢复完成 · 任务仅为文本草案'},900);
add('任务与恢复','activity.updated',{id:run+'-recovery',kind:'phase',label:'演示失败恢复',status:'completed',detail:'示意触发时间已补齐，未执行任务。'},900);

add('切换与收尾','resource.open',{artifactId:table},1800);
add('切换与收尾','artifact.focus',{artifactId:table},1200);
add('切换与收尾','run.note',{text:'现在验证窗口收起与重开：协作窗口会短暂收起，再恢复为侧栏，最后打开概览页。收起不会停止当前Agent。'},900);
add('切换与收尾','panel.close',{},1800);
add('切换与收尾','panel.open',{mode:'side'},1800);
add('切换与收尾','resource.open',{artifactId:page},1600);
add('切换与收尾','artifact.focus',{artifactId:page},900);
add('切换与收尾','step.updated',{id:run+'-finish',label:'本轮UI指令发送完成',status:'completed',detail:'页面、表格、编辑、任务文本、模拟恢复及窗口切换；未保存/发布平台资源。'},800);
add('切换与收尾','run.note',{text:'联调预览已留在左侧成果清单：销售概览、商品销售表、日报任务草案。可切换查看，表格支持搜索/排序。所有数字均为模拟；任务未部署未运行。前端应用结果将按实际回执汇总。'},1000);

// Validate the WHOLE sequence locally before sending any UI event.
const validation=createProjection(sessionId);
for(const {event}of events){assert.ok(Buffer.byteLength(JSON.stringify(event))<19000);validation.publish(event);}
assert.equal(validation.value.artifacts.find(a=>a.id===table).rows.length,6);
assert.equal(validation.value.artifacts.find(a=>a.id===page).sections.length,3);
assert.ok(validation.value.artifacts.every(a=>a.buildState==='ready'));
await mkdir(root,{recursive:true,mode:0o700});
const results=[];
async function cli(args){const {stdout}=await exec(process.execPath,[publisher,...args],{timeout:10000,maxBuffer:256000});const result=JSON.parse(stdout);if(result.ok===false)throw Error(result.error?.message||result.error||'本地发布被拒绝');return result;}
async function receipt(id){return(await cli(['receipt','--session',sessionId,'--id',id])).data;}
let stage='';
try{
 for(const item of events){
  if(stage!==item.stage){stage=item.stage;console.log(JSON.stringify({stage,run,notice:'本地联调预览；模拟数据；不操作平台'}));}
  const path=new URL(item.event.id+'.json',root);await writeFile(path,JSON.stringify(item.event),{mode:0o600,flag:'wx'});
  await cli(['--session',sessionId,'--file',fileURLToPath(path)]);
  await delay(item.pause);let ack=await receipt(item.event.id);
  // Browser intentionally pauses while hidden. Give the user time to return to the foreground.
  const ackDeadline=Date.now()+(sendOnly?0:results.length===0?45000:2000);
  while(['accepted','unknown'].includes(ack?.status)&&Date.now()<ackDeadline){await delay(800);ack=await receipt(item.event.id);}
  results.push({id:item.event.id,type:item.event.type,stage,status:ack?.status||'unknown'});
  console.log(JSON.stringify(results.at(-1)));
  if(!sendOnly&&results.length===1&&ack?.status!=='applied')throw Error('所选会话的网页未确认应用初始清单。已停止后续指令；请核对页面绑定并保持前台。');
  if(ack?.status==='failed')throw Error('网页报告应用失败，停止后续指令。');
 }
 const counts=results.reduce((a,r)=>(a[r.status]=(a[r.status]||0)+1,a),{});
 const summary={ok:true,dispatchOnly:sendOnly,browserAppliedAll:counts.applied===results.length,run,sessionId,commands:results.length,distinctCommands:new Set(results.map(r=>r.type)).size,receipts:counts,artifacts:{page,table,task},notice:'仅实际UI预览；数据模拟；平台保存/发布/任务运行均未执行；接收不代表网页已应用',results};
 await writeFile(new URL('summary.json',root),JSON.stringify(summary,null,2),{mode:0o600});console.log(JSON.stringify({...summary,results:undefined,summaryFile:fileURLToPath(new URL('summary.json',root))}));
}catch(error){await writeFile(new URL('summary.json',root),JSON.stringify({ok:false,run,sessionId,error:error.message,results},null,2),{mode:0o600});throw error;}
