/* Read-only example: native pivot aggregates + bounded detail sample -> UI previews, never saves/publishes business. */
import{writeFile,access}from'node:fs/promises';import{fileURLToPath}from'node:url';import{setTimeout as delay}from'node:timers/promises';import{publishEvent,RUNTIME}from'../src/runtime/publisher.mjs';
const argv=process.argv.slice(2),option=name=>argv[argv.indexOf(name)+1];
const runtimePath=argv.includes('--runtime')?option('--runtime'):RUNTIME,sessionId=argv.includes('--session')?option('--session'):undefined;
const stamp=new Date().toISOString(),events=[];
async function send(type,payload){const event={id:'sales-'+Date.now()+'-'+events.length,type,payload};events.push(event);await publishEvent({runtimePath,sessionId,event});}
const amount=n=>n.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
await send('plan.updated',{title:'订单商品明细 · 智能销售分析',items:[{id:'sales-report',kind:'page',name:'智能销售主题分析'},{id:'sales-evidence',kind:'table',name:'销售趋势核验'}]});
await send('step.updated',{id:'read-sales',label:'只读获取订单商品明细与平台透视',status:'running',detail:'区分平台视图汇总和明细样本，不修改订单。'});
const response=await fetch('http://127.0.0.1:4173/api/table-query/sales',{headers:{Origin:'http://127.0.0.1:4173','X-Requested-With':'PersonalWorkbenchDemo'},signal:AbortSignal.timeout(60000)}),source=await response.json();
if(!response.ok||source.ok!==true)throw Error('订单数据读取失败，未生成虚构报表');
const{pivot,records}=source.data,columns=pivot?.data?.crossTable?.footerData?.columnMeasures;
if(!columns||!Array.isArray(records?.data))throw Error('平台数据结构变化，请先核对视图口径');
const days=Object.keys(columns).filter(key=>/^\d{4}-\d{2}-\d{2}$/.test(key)).sort().map(date=>({date,qty:columns[date]?.['销售数']?.value,sales:columns[date]?.['销售金额']?.value}));
if(!days.length||days.some(d=>!Number.isFinite(d.qty)||!Number.isFinite(d.sales)||d.sales<0))throw Error('原生视图指标无效，不能以0替代失败');
const sum=(rows,key)=>rows.reduce((n,d)=>n+d[key],0),latest=days.slice(-7),prior=days.slice(-14,-7),sales=sum(days,'sales'),qty=sum(days,'qty'),recent=sum(latest,'sales'),priorSales=sum(prior,'sales');
const change=priorSales>0?((recent/priorSales-1)*100):null,peak=days.reduce((a,b)=>a.sales>=b.sales?a:b);
const description=`数据源：订单商品明细1752，平台已有透视视图839的底部按日汇总；范围${days[0].date}至${days.at(-1).date}。金额单位沿用原视图，未换算币种；不是全企业全量承诺。查询时间${stamp}。`;
await send('step.updated',{id:'read-sales',label:'读取完成并核对来源',status:'completed',detail:`平台视图${days.length}个统计日；明细仅首${records.data.length}行样本。`});
await send('step.updated',{id:'analyze-sales',label:'分析销售趋势与口径风险',status:'running'});
await send('artifact.updated',{id:'sales-report',kind:'page',name:'智能销售主题分析',description,metrics:[{label:'平台视图销售金额',value:amount(sales),hint:'按原生视图统计，未换算币种'},{label:'平台视图销售数',value:qty.toLocaleString('zh-CN'),hint:'不是订单数或客户数'},{label:'视图覆盖统计日',value:String(days.length),hint:`${days[0].date}—${days.at(-1).date}`},{label:'可核验明细样本',value:String(records.data.length),hint:'首批明细，不是全量分母'}],chart:{labels:latest.map(d=>d.date.slice(5)),values:latest.map(d=>d.sales)},sections:[]});
await send('artifact.focus',{artifactId:'sales-report'});
if(argv.includes('--wait-ui-ack')){const deadline=Date.now()+30000;while(true){try{await access(runtimePath+'.observed');break;}catch{if(Date.now()>deadline)throw Error('未观察到前端部分页面，停止验收推进');await delay(50);}}}
const sections=[
 {id:'scope',title:'范围与数据质量',text:`平台汇总来自现有视图，不与${records.data.length}行明细样本混算。${records.total===0&&records.data.length?'明细接口total=0但实际有返回行，数量元信息矛盾，未作为总数或比率分母。':'样本不用于外推全量商品排名。'}报表仅使用视图汇总和样本数量，不展示客户个人字段，也不根据样本虚构利润、客单价或退款率。`},
 {id:'trend',title:'最后7个有数据日的趋势',text:`${latest[0].date}—${latest.at(-1).date}的视图销售金额为${amount(recent)}。${prior.length===7&&change!==null?`相对前7个有数据日变化${change>=0?'+':''}${change.toFixed(2)}%。`:'上一窗口不足或基数为0，不计算变动率。'}这不是相对今天的“近7日”，也不是同比。`},
 {id:'peak',title:'销售峰值与后续核验',text:`视图范围内最高统计日为${peak.date}，金额${amount(peak.sales)}，占本视图金额合计${sales>0?(peak.sales/sales*100).toFixed(2):'不可计算'}%。建议在相同时间窗按店铺、商品、活动及退款状态拆解核对；当前没有足够证据推断增长原因。`},
 {id:'action',title:'建议动作与边界',text:'先确认视图筛选、日期定义和销售金额是否含退款，再做渠道贡献、商品结构与价格变化的对照。商品排名与退款分析需全量受控聚合，不应把首200行样本当作结论。当前只生成网页预览，未建表、保存平台草稿或发布页面。'}
];
for(const section of sections)await send('page.section.updated',{artifactId:'sales-report',section});
await send('artifact.updated',{id:'sales-evidence',kind:'table',name:'销售趋势核验',description:'核验表来自相同平台视图的最后7个有数据日，不是明细抽样合计。',columns:['统计日','平台销售数','平台销售金额'],rows:latest.map(d=>[d.date,d.qty,d.sales.toFixed(2)])});
await send('artifact.ready',{artifactId:'sales-evidence'});await send('artifact.ready',{artifactId:'sales-report'});await send('step.updated',{id:'analyze-sales',label:'趋势与口径核验预览完成',status:'completed',detail:'预览完成，不等于平台保存或发布。'});
await writeFile(fileURLToPath(new URL('./order-sales-current-events.json',import.meta.url)),JSON.stringify({notice:'本机报表快照；重放仅载入历史预览，不代表重新读取当前数据',queriedAt:stamp,source:{tableId:1752,viewId:839,sampleRows:records.data.length,days:days.length,range:[days[0].date,days.at(-1).date]},events},null,2));
console.log(JSON.stringify({ok:true,previewOnly:true,range:[days[0].date,days.at(-1).date],statisticalDays:days.length,sampleRows:records.data.length,platformSalesAmount:sales,platformSalesQty:qty,savedToPlatform:false}));
