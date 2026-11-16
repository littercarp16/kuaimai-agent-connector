const products={type:'artifact',id:'products',kind:'table',name:'商品主档',description:'模拟数据 · 以商品编码关联库存与销量，尚未保存到平台',columns:['商品编码','商品名称','类目','负责人'],rows:[['KM-1001','轻盈针织开衫','春秋女装','林晓'],['KM-1002','高腰直筒牛仔裤','四季牛仔','陈言'],['KM-1003','简约棉质衬衫','基础上装','林晓'],['KM-1004','轻户外防风外套','户外系列','周宁'],['KM-1005','日常百搭短袖','基础上装','陈言']]};
const inventory={type:'artifact',id:'inventory',kind:'table',name:'库存与销量',description:'模拟数据 · 建议量仅供产品交互演示，不构成真实补货决策',columns:['商品编码','近7日销量','可用库存','安全库存','建议补货','状态'],rows:[['KM-1001',126,42,80,164,'优先补货'],['KM-1002',84,160,60,0,'库存充足'],['KM-1003',98,35,70,133,'优先补货'],['KM-1004',42,90,30,0,'库存充足'],['KM-1005',154,58,100,196,'关注缺货']]};
const overview={type:'artifact',id:'overview',kind:'page',name:'补货分析概览',description:'模拟数据 · 未保存的页面方案',metrics:[{label:'近7日销量',value:'604',hint:'件 · 模拟数据'},{label:'待关注商品',value:'3',hint:'建议人工复核'},{label:'建议补货',value:'493',hint:'件 · 未生成采购单'}],chart:{labels:['周一','周二','周三','周四','周五','周六','周日'],values:[68,86,73,96,82,104,95]},sections:[{title:'优先关注 3 款商品',text:'针织开衫、棉质衬衫与百搭短袖的库存覆盖偏低。先核对在途库存和供应商交期，再确认补货数量。'},{title:'数据口径待确认',text:'销量是否扣除退款、安全库存是否按SKU分别设置，以及在途采购的计入方式，均需业务人员确认。'}]};
const task={type:'artifact',id:'sync',kind:'task',name:'每日数据同步草案',description:'任务方案预览 · 未保存、未部署、未运行',code:'async function main(ctx) {\n  // 1. 通过已授权连接读取商品、销量与库存\n  // 2. 按商品编码关联，校验重复和缺失数据\n  // 3. 生成待复核的补货建议\n  // 真实连接、字段及写入范围仍需确认\n}'};
const wrap=value=>'```kmmdtable\n'+JSON.stringify(value)+'\n```';
export const DEMO_STAGES=[
  '这是交互演示，不会调用模型或写入业务。先准备两张表、一个分析页面和一份任务草案。\n'+wrap({type:'plan',title:'商品补货分析',items:[products,inventory,overview,task].map(({id,kind,name})=>({id,kind,name}))}),
  '商品主档预览已就绪。接下来整理库存与销量的关联口径。\n'+wrap(products),
  '库存分析预览已就绪。建议量仅为模拟结果，真实执行前需要确认业务口径。\n'+wrap(inventory),
  '页面方案已生成，可以查看指标、趋势及人工复核提示。\n'+wrap(overview),
  '同步任务草案也已准备好。全部内容仍是未保存预览，没有创建表格、发布页面或启用调度。\n'+wrap(task)
];
