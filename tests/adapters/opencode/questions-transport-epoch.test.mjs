import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {OpenCode} from '@opencode/client';
import {createConnector} from '../../../src/http/server.mjs';
import {sharedOpenCode} from '../../../src/adapters/opencode/shared-opencode.mjs';

const until=async fn=>{const end=Date.now()+4500;while(!await fn()){if(Date.now()>end)throw Error('等待业务条件超时');await new Promise(r=>setTimeout(r,10));}};
const activity={id:'tool:t_review',kind:'tool',toolName:'shell',label:'调用shell',status:'completed',hasDetails:true};
test('RED finding 4: held tool detail from a disconnected native epoch is rejected after same-hub reconnect',async t=>{
  let state,release,reading=false,watches=0;
  const adapter={health:async()=>({ready:true}),bindSession:async id=>({id,title:id}),readShared:async()=>({status:'completed',messages:[],activities:[activity]}),watch:(id,e,s)=>{state=s;watches++;return{ready:Promise.resolve(),close(){}};},readToolDetail:async()=>{reading=true;await new Promise(r=>{release=r;});return{toolId:'t_review',result:{text:'OLD_CONNECTION_RESULT'}};}};
  const origin='http://127.0.0.1:4173',bridge=createConnector({adapter,allowedOrigins:[origin],autoTrust:{origin,sessionId:'ses_review'}});bridge.server.listen(0,'127.0.0.1');await once(bridge.server,'listening');t.after(()=>bridge.close());
  const base=`http://127.0.0.1:${bridge.server.address().port}`,request=async(path,body,token)=>{const response=await fetch(base+path,{method:body?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json','X-Km-Agent':'1',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});return{status:response.status,...await response.json()};};
  const handshake=await request('/v1/handshake',{}),token=handshake.data.token;const old=request('/v1/tool/detail',{sessionId:'ses_review',toolId:'t_review'},token);await until(()=>reading);state('disconnected');
  await until(async()=>watches===2&&(await request('/v1/snapshot',null,token)).data.binding.transport==='connected');release();const result=await old;assert.equal(result.status,409);assert.doesNotMatch(JSON.stringify(result),/OLD_CONNECTION_RESULT/);
});

test('native readToolDetail rejects same-session bound-context replacement while its first SDK get awaits',async t=>{
  let hold=false,release,held=false;const server=http.createServer(async(req,res)=>{
    const path=new URL(req.url,'http://fixture').pathname;res.setHeader('Content-Type','application/json');
    if(path==='/api/session/ses_review'){if(hold){hold=false;held=true;await new Promise(r=>{release=r;});}return res.end(JSON.stringify({data:{id:'ses_review',location:{directory:'/workspace'},time:{}}}));}
    if(path.endsWith('/message'))return res.end(JSON.stringify({data:[{id:'msg_review',type:'assistant',time:{completed:2},content:[{type:'tool',id:'t_review',name:'shell',state:{status:'completed',input:{command:'npm test'},content:[{type:'text',text:'OLD_BOUND_CONTEXT_RESULT'}]},time:{created:1,completed:2}}]}]}));
    if(path==='/api/session/active')return res.end(JSON.stringify({data:{}}));res.writeHead(404);res.end('{}');
  });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
  const client=OpenCode.make({baseUrl:`http://127.0.0.1:${server.address().port}`});client.session.form=undefined;client.session.inbox=undefined;
  const adapter=sharedOpenCode({current:()=>({client}),health:async()=>({ready:true}),directory:'/workspace'});await adapter.bindSession('ses_review');await adapter.readShared('ses_review');hold=true;
  const pending=adapter.readToolDetail('ses_review','t_review');await until(()=>held);await adapter.bindSession('ses_review');release();await assert.rejects(()=>pending,/绑定|上下文|连接/);
});

test('late uncached history cannot populate the replacement bound context with old native details',async t=>{
  let release,held=false,holdMessage=true,text='OLD_BOUND_CONTEXT_RESULT';const server=http.createServer(async(req,res)=>{
    const path=new URL(req.url,'http://fixture').pathname;res.setHeader('Content-Type','application/json');
    if(path==='/api/session/ses_review')return res.end(JSON.stringify({data:{id:'ses_review',location:{directory:'/workspace'},time:{}}}));
    if(path.endsWith('/message')){const captured=text;if(holdMessage){holdMessage=false;held=true;await new Promise(r=>{release=r;});}return res.end(JSON.stringify({data:[{id:'msg_review',type:'assistant',time:{completed:2},content:[{type:'tool',id:'t_review',name:'shell',state:{status:'completed',input:{command:'npm test'},content:[{type:'text',text:captured}]},time:{created:1,completed:2}}]}]}));}
    if(path==='/api/session/active')return res.end(JSON.stringify({data:{}}));res.writeHead(404);res.end('{}');
  });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
  const client=OpenCode.make({baseUrl:`http://127.0.0.1:${server.address().port}`});client.session.form=undefined;client.session.inbox=undefined;
  const adapter=sharedOpenCode({current:()=>({client}),health:async()=>({ready:true}),directory:'/workspace'});await adapter.bindSession('ses_review');const pending=adapter.readToolDetail('ses_review','t_review');await until(()=>held);await adapter.bindSession('ses_review');text='NEW_BOUND_CONTEXT_RESULT';release();await assert.rejects(()=>pending,/绑定|上下文|连接/);
  const fresh=await adapter.readToolDetail('ses_review','t_review');assert.match(fresh.result.text,/NEW_BOUND_CONTEXT_RESULT/);assert.doesNotMatch(JSON.stringify(fresh),/OLD_BOUND_CONTEXT_RESULT/);
});
