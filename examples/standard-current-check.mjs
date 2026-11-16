/* Current-session UI acceptance only. Reuses an explicitly labeled historical snapshot; no business API. */
import{readFile,writeFile,access}from'node:fs/promises';import{fileURLToPath}from'node:url';import{setTimeout as delay}from'node:timers/promises';import{publishEvent}from'../src/runtime/publisher.mjs';
const sessionId=process.argv[2];if(!/^ses[\w-]+$/.test(sessionId||''))throw Error('请明确当前会话');
const runtimePath=fileURLToPath(new URL('../.runtime/current-chat-sales-check.json',import.meta.url)),deadline=Date.now()+10000;while(true){try{await access(runtimePath);break;}catch{if(Date.now()>deadline)throw Error('观察验收未就绪');await delay(40);}}
const saved=JSON.parse(await readFile(new URL('./order-sales-current-events.json',import.meta.url),'utf8')),base=saved.events.find(e=>e.type==='artifact.updated'&&e.payload.id==='sales-report').payload,events=[],prefix='standard-current-'+Date.now();
async function send(type,payload){const event={protocol:'km-agent/1',id:prefix+'-'+events.length,type,payload};events.push(event);await publishEvent({runtimePath,sessionId,event});}
await send('plan.updated',{title:'标准协议实际会话验收',items:[{id:'sales-report',kind:'page',name:'销售增长观察 · 独立风格'}]});
await send('resource.create',{id:'sales-report',kind:'page',name:'销售增长观察 · 独立风格',appearance:{theme:'ink',accent:'#d6f36a',layout:'editorial'}});
await send('work.status',{artifactId:'sales-report',status:'running',label:'正在装配独立风格报表'});
await send('artifact.updated',{...base,name:'销售增长观察 · 独立风格',description:`历史数据快照，查询时间${saved.queriedAt}，本次未重新查询平台。用于当前真实会话UI指令验收；未保存或发布。`,appearance:{theme:'ink',accent:'#d6f36a',layout:'editorial'},chart:{...base.chart,type:'line'}});
const end=Date.now()+30000;while(true){try{await access(runtimePath+'.observed');break;}catch{if(Date.now()>end)throw Error('未确认部分页面已显示');await delay(40);}}
for(const e of saved.events.filter(e=>e.type==='page.section.updated'))await send(e.type,e.payload);
await send('work.status',{artifactId:'sales-report',status:'completed',label:'历史快照界面已装配'});await send('artifact.ready',{artifactId:'sales-report'});
await writeFile(new URL('./standard-current-check-events.json',import.meta.url),JSON.stringify({notice:'真实当前会话UI验收；数据是历史快照，非重新查询',sourceQueriedAt:saved.queriedAt,events},null,2));
console.log(JSON.stringify({ok:true,realCurrentSession:true,protocol:'km-agent/1',events:events.length,businessCalls:0,data:'historical-snapshot',savedToPlatform:false}));
