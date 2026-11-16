import{test}from'node:test';import assert from'node:assert/strict';import{createSharedHub}from'../../src/session/shared-hub.mjs';
const wait=async f=>{const end=Date.now()+3000;while(!f()){if(Date.now()>end)throw Error('条件等待超时');await new Promise(r=>setTimeout(r,10));}};
const evt=(type,data,id=crypto.randomUUID())=>({id,type,data:{sessionID:'ses_a',...data}});
function base(overrides={}){return{health:async()=>({ready:true}),bindSession:async()=>({id:'ses_a',title:'A'}),readShared:async()=>({status:'idle',messages:[]}),watch:()=>({ready:Promise.resolve(),close(){}}),installBridge:async()=>{},removeBridge:async()=>{},...overrides};}
const make=adapter=>createSharedHub({adapter,session:{id:'ses_a',title:'A'},instructionKey:'test',instruction:'test',onChange(){}});
test('事件覆盖先于快照：初始化期间移动立即阻断，不能进入connected转发新目录文本',async()=>{
 let observing=false,moved=false,callback,state;
 const hub=make(base({readShared:async()=>{moved=true;if(observing)state('disconnected');return{status:'running',messages:[]};},watch:(id,e,s)=>{observing=true;callback=e;state=s;return{ready:Promise.resolve(),close(){}};}}));
 let rejected=false;try{await hub.start();}catch{rejected=true;}
 callback?.(evt('session.text.delta',{assistantMessageID:'msg_x',ordinal:0,delta:'其他目录内容'}));
 assert.equal(moved,true);assert.equal(rejected,true);assert.doesNotMatch(JSON.stringify(hub.projection.value.messages),/其他目录内容/);await hub.close();
});
test('初始化缓冲中的终态不能丢失，快照与重叠delta不能重复拼接',async()=>{
 let callback;
 const hub=make(base({watch:(id,e)=>{callback=e;return{ready:Promise.resolve(),close(){}};},readShared:async()=>{
  if(callback){callback(evt('session.text.started',{assistantMessageID:'msg_x',ordinal:0}));callback(evt('session.text.delta',{assistantMessageID:'msg_x',ordinal:0,delta:'A'}));callback(evt('session.text.delta',{assistantMessageID:'msg_x',ordinal:0,delta:'B'}));callback(evt('session.execution.succeeded',{}));}
  return{status:'running',messages:[{id:'msg_x',role:'assistant',text:'AB',segments:[{ordinal:0,text:'AB'}]}]};
 }}));await hub.start();assert.equal(hub.projection.value.status,'completed');assert.equal(hub.projection.value.messages[0].text,'AB');await hub.close();
});
test('撤销发生在安装说明中，迟到安装完成后仍须清理说明',async()=>{
 let release,installing=false,installed=false;
 const hub=make(base({installBridge:async()=>{installing=true;await new Promise(r=>{release=r;});installed=true;},removeBridge:async()=>{installed=false;}}));
 const starting=hub.start();await wait(()=>installing);const closing=hub.close();release();await Promise.all([starting,closing]);assert.equal(installed,false);
});
test('原生执行完成早于提交回执，迟到回执不能把终态改回queued',async()=>{
 let release,callback;
 const hub=make(base({watch:(id,e)=>{callback=e;return{ready:Promise.resolve(),close(){}};},sendShared:()=>new Promise(r=>{release=r;})}));await hub.start();
  const owner={};hub.members.add(owner);const pending=hub.submit(owner, {requestId:crypto.randomUUID(),text:'需求'});callback(evt('session.inbox.enqueued',{inboxID:'msg_input',item:{type:'user',payload:{text:'需求'},delivery:'queue'}}));callback(evt('session.execution.started',{}));callback(evt('session.execution.succeeded',{}));release({id:'msg_input'});await pending;
 assert.equal(hub.projection.value.status,'completed');assert.equal(hub.projection.value.messages.filter(m=>m.role==='user').length,1);await hub.close();
});
test('绑定已有生成段落时，用事件触发的规范文本核验消除重叠，不重复拼接或覆盖结束文本',async()=>{
 let callback,reads=0,release;
 const hub=make(base({watch:(id,e)=>{callback=e;return{ready:Promise.resolve(),close(){}};},readShared:async()=>{reads++;if(reads===1){callback(evt('session.text.delta',{assistantMessageID:'msg_x',ordinal:0,delta:'B'}));return{status:'running',messages:[{id:'msg_x',role:'assistant',text:'AB',segments:[{ordinal:0,text:'AB'}]}]};}return new Promise(r=>{release=r;});}}));
 await hub.start();assert.equal(hub.projection.value.messages[0].text,'AB');callback(evt('session.text.delta',{assistantMessageID:'msg_x',ordinal:0,delta:'C'}));await wait(()=>release);
 callback(evt('session.text.ended',{assistantMessageID:'msg_x',ordinal:0,text:'ABCD'}));release({status:'running',messages:[{id:'msg_x',role:'assistant',text:'ABC',segments:[{ordinal:0,text:'ABC'}]}]});await new Promise(r=>setImmediate(r));assert.equal(hub.projection.value.messages[0].text,'ABCD');await hub.close();
});
