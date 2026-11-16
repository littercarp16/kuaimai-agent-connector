/* Shared, data-only preview protocol. No HTML, evaluation or business write capability. */
(() => {
  'use strict';
  const kinds = new Set(['table','page','dashboard','task']);
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  function text(value, limit=600, optional=false) {
    if (optional && value == null) return '';
    if (typeof value !== 'string' || value.length > limit || (!optional && !value.trim())) throw Error('文本格式或长度不符合约定');
    return value;
  }
  function list(value, max) { if (!Array.isArray(value) || value.length > max) throw Error('列表超出预览限制'); return value; }
  function identity(raw) {
    if (!object(raw) || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.id) || !kinds.has(raw.kind)) throw Error('资源标识或类型不支持');
    return {id:raw.id,kind:raw.kind,name:text(raw.name,70)};
  }
  function normalize(raw) {
    if (!object(raw)) throw Error('预览需要结构化对象');
    if (raw.type === 'plan') {
      const items=list(raw.items,12).map(identity);
      if (!items.length || new Set(items.map(x=>x.id)).size !== items.length) throw Error('构建清单为空或包含重复标识');
      return {type:'plan',title:text(raw.title,70),items};
    }
    if (raw.type !== 'artifact') throw Error('不支持的协议块');
    const item={type:'artifact',...identity(raw),description:text(raw.description,1000,true)};
    if(raw.appearance){const a=raw.appearance;if(!object(a)||a.theme&&!['paper','ink','forest'].includes(a.theme)||a.accent&&!/^#[0-9a-fA-F]{6}$/.test(a.accent)||a.layout&&!['dashboard','editorial'].includes(a.layout)||a.density&&!['compact','comfortable'].includes(a.density))throw Error('成果外观不符合约定');item.appearance={theme:a.theme||'paper',accent:a.accent||'#197766',layout:a.layout||'dashboard',density:a.density||'comfortable'};}
    if(raw.document){if(!['page','dashboard'].includes(item.kind)||!object(raw.document))throw Error('仅页面和仪表盘支持独立文档');item.document={html:text(raw.document.html,12000),css:text(raw.document.css,4000,true)};}
    if(raw.interactions){if(item.kind!=='table'||!object(raw.interactions)||Object.keys(raw.interactions).some(k=>!['search','sort'].includes(k)||typeof raw.interactions[k]!=='boolean'))throw Error('交互能力不支持');item.interactions={search:raw.interactions.search===true,sort:raw.interactions.sort===true};}
    if(raw.buildState!==undefined){if(!['building','ready'].includes(raw.buildState))throw Error('构建状态不支持');item.buildState=raw.buildState;}
    if (item.kind === 'table') {
      item.columns=list(raw.columns,16).map(x=>text(x,70));
      if (!item.columns.length) throw Error('表格需要字段');
      item.rows=list(raw.rows,50).map(row=>{
        if (!Array.isArray(row) || row.length !== item.columns.length) throw Error('数据列数不匹配');
        return row.map(cell=>{if(cell!==null && !['string','number','boolean'].includes(typeof cell))throw Error('单元格类型不支持');return text(cell==null?'':String(cell),600,true);});
      });
    } else if (item.kind === 'page'||item.kind==='dashboard') {
      item.metrics=list(raw.metrics||[],6).map(x=>({label:text(x.label,40),value:text(x.value,60),hint:text(x.hint,90,true)}));
      item.sections=list(raw.sections||[],8).map(x=>({title:text(x.title,70),text:text(x.text,1000)}));
      if (raw.chart) {
        const labels=list(raw.chart.labels,12).map(x=>text(x,40)),values=list(raw.chart.values,12);
        if (!labels.length || labels.length!==values.length || values.some(x=>!Number.isFinite(x)||x<0||x>1e12)) throw Error('图表数据不符合约定');
        if(raw.chart.type&&!['bar','line'].includes(raw.chart.type))throw Error('图表类型不支持');item.chart={labels,values,...(raw.chart.type?{type:raw.chart.type}:{})};
      }
    } else item.code=text(raw.code,6000,true);
    return item;
  }
  function parseOutput(source) {
    const input=String(source||'').slice(0,180000),artifacts=[],warnings=[];let plan=null;
    const clean=input.replace(/```kmmdtable\s*\r?\n([\s\S]*?)```/g,(_,json)=>{
      try {const value=normalize(JSON.parse(json));if(value.type==='plan')plan=value;else artifacts.push(value);}
      catch {warnings.push('一个结构化预览块未通过校验，未呈现或执行。');}
      return '';
    }).replace(/```kmmdtable[\s\S]*$/,'').trim();
    return {plan,artifacts,warnings,text:clean};
  }
  function buildItems(run) {
    const artifacts=run?.artifacts||[],items=[...(run?.plan?.items||[])];
    for(const item of artifacts)if(!items.some(x=>x.id===item.id))items.push(item);
    let generating=false;
    return items.map(item=>{
      const artifact=artifacts.find(x=>x.id===item.id);let state=artifact?(artifact.buildState==='building'?'partial':'preview'):'missing';
      if(state==='missing'&&run?.status==='running'&&!generating){state='generating';generating=true;}
      return {...item,state};
    });
  }
  const isConnectorHealth=value=>object(value)&&value.service==='kuaimai-agent-connector'&&[1,2].includes(value.protocolVersion)&&typeof value.instanceId==='string'&&value.instanceId.length>0;
  globalThis.KmAgentModel=Object.freeze({parseOutput,buildItems,isConnectorHealth});
})();
