import http from 'node:http';
import { createHash,randomBytes,randomInt,randomUUID,timingSafeEqual } from 'node:crypto';
import '../protocol/model.js';
import { DEMO_STAGES } from './demo.mjs';
import {createSharedHub} from '../session/shared-hub.mjs';
import {fileURLToPath} from 'node:url';
import{contract,PROTOCOL}from'../protocol/protocol.mjs';
import{createFollowManager}from'../session/follow-manager.mjs';
import{FILE_LIMITS,normalizeUploads}from'../tools/prompt-files.mjs';
import{createWorkBuddyStore,WORKBUDDY_ADAPTER,WORKBUDDY_CAPABILITIES,WorkBuddyFailure}from'../adapters/workbuddy/workbuddy-store.mjs';
import{nextSourceOrder}from'../session/source-order.mjs';
import{redactText}from'../tools/display-safety.mjs';
import{nativeCapabilities}from'../adapters/native-registry.mjs';
import { QwenDesktopFailure } from '../runtime/qwen-desktop.mjs';
import { CodexDesktopFailure } from '../runtime/codex-desktop.mjs';
import { normalizePageContext } from '../protocol/page-context.mjs';
import { nullLogger } from '../runtime/logger.mjs';
import { observeRequest } from './request-log.mjs';

const M=globalThis.KmAgentModel, BUSY=new Set(['running','stopping','unknown']);
class Failure extends Error {constructor(status,message){super(message);this.status=status;}}
const fail=(status,message)=>{throw new Failure(status,message);};
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
const equal=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y);};

export function createConnector({adapter,allowedOrigins=['http://127.0.0.1:4173'],pairCode=String(randomInt(100000,1000000)),onPairCode=()=>{},publisherKey=randomBytes(32).toString('base64url'),publisherCommand=null,onBindings=()=>{},autoTrust=null,now=Date.now,enableWorkBuddy=false,workBuddyOptions={},enableMultiAgentFollow=false,codexDesktop=null,qwenDesktop=null,desktopConnect=null,projectIndependentSessions=false,logger=nullLogger}={}) {
  if(!adapter?.health)throw Error('需要 Agent 适配器');
  const origins=new Set(allowedOrigins.map(value=>{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.origin!==value)throw Error('来源必须是精确HTTP Origin');return value;}));
  if(autoTrust&&(!origins.has(autoTrust.origin)||!/^http:\/\/127\.0\.0\.1:\d+$/.test(autoTrust.origin)||autoTrust.sessionId!=null&&!/^ses[\w-]+$/.test(autoTrust.sessionId)))throw Error('自动授权必须指定受信loopback来源及有效会话');
  if(autoTrust?.allowControl===true&&(!autoTrust.sessionId||adapter.descriptor?.id==='generic'||adapter.descriptor?.id==='workbuddy'))throw Error('网页控制必须明确原生OpenCode会话');
  const instanceId=randomUUID(),clients=new Map(),streams=new Set(),rates=new Map(),hubs=new Map(),cleanups=new Set();
  let code=pairCode,codeExpires=now()+10*60e3,closed=false,agent={ready:false,version:null,message:'正在检查 OpenCode'};
  let healthPromise=null,healthAt=0,follow;
  function connected(client) { client.logId=randomUUID(); logger.info('client.connected',{instanceId,clientId:client.logId,origin:client.websiteOrigin||client.origin}); }
  function disconnected(client,reason) { if(client.logDisconnected)return;client.logDisconnected=true;logger.info('client.disconnected',{instanceId,clientId:client.logId,origin:client.websiteOrigin||client.origin,reason}); }
  const workBuddy=enableWorkBuddy?createWorkBuddyStore({...workBuddyOptions,...(enableMultiAgentFollow?{workspaceId:workBuddyOptions.workspaceId||'ws_'+createHash('sha256').update(process.cwd()).digest('hex')}:{ }),instanceId,publisherKey,now,onOpen:candidate=>{if(enableMultiAgentFollow)follow.offer({...candidate,reason:'task-open'});},onChange:()=>{for(const client of clients.values())if(client.active){push(client);follow.tick(client);}}}):null;
  const isWorkBuddy=client=>client.hub?.session.provider==='workbuddy';
  const publicHealth=(origin)=>({service:'kuaimai-agent-connector',protocolVersion:2,interactionProtocol:PROTOCOL,instanceId,mode:'shared',agent,adapter:adapter.descriptor||{id:'opencode',status:'native'},capabilities:{projectIndependentSessions,qwenDesktopPreparation:Boolean(qwenDesktop),codexDesktopRestart:Boolean(codexDesktop),codexDesktopDockPersistence:codexDesktop?.capabilities?.dockPersistence===true,multiAgentFollow:enableMultiAgentFollow,autoHandshake:Boolean(autoTrust&&autoTrust.origin===origin),workbuddyPublish:Boolean(workBuddy),newSession:typeof adapter.createSharedSession==='function',workspaceFiles:typeof adapter.searchWorkspaceFiles==='function',attachments:typeof adapter.sendShared==='function',nativeQuestions:typeof adapter.listQuestions==='function'&&typeof adapter.replyQuestion==='function'&&typeof adapter.rejectQuestion==='function',followSessions:typeof adapter.watchRelevantSessions==='function',toolDetails:true,toolDetailFetch:typeof adapter.readToolDetail==='function',uiCommands:true,uiReceipts:true,demo:true,submitPrompt:agent.ready&&(typeof adapter.sendShared==='function'||typeof adapter.send==='function'),sharedSession:typeof adapter.bindSession==='function',nativeEvents:typeof adapter.watch==='function',cancelRun:typeof adapter.interruptShared==='function'||typeof adapter.interrupt==='function',previewArtifacts:true,businessWrite:false}});
  async function checkHealth(){if(healthPromise)return healthPromise;if(healthAt&&now()-healthAt<5000)return agent;healthPromise=Promise.resolve().then(()=>adapter.health()).then(value=>{agent={ready:value.ready===true,version:typeof value.version==='string'?value.version:null,message:String(value.message||'').slice(0,180)};healthAt=now();return agent;}).catch(error=>{logger.error('agent.health_failed',{instanceId,error});agent={ready:false,version:null,message:'OpenCode 状态检查失败'};return agent;}).finally(()=>{healthPromise=null;});return healthPromise;}
  const nativeFor=client=>client.hub?.adapter||adapter;
  const agentFor=client=>adapter.agentFor&&client.hub?adapter.agentFor(nativeFor(client)):agent;
  const capabilities=client=>isWorkBuddy(client)?{...publicHealth(client.origin).capabilities,...WORKBUDDY_CAPABILITIES,nativeApprovals:false}:{...publicHealth(client.origin).capabilities,...nativeCapabilities(nativeFor(client),agentFor(client))};
  function snapshot(client){const wb=isWorkBuddy(client),native=nativeFor(client),selectedAdapter=wb?WORKBUDDY_ADAPTER:native.descriptor||publicHealth().adapter;return {instanceId,revision:client.revision,mode:wb?'workbuddy-publish':'shared',provider:selectedAdapter.id,adapter:selectedAdapter,agent:wb?{ready:client.hub.transport==='connected',version:null,message:'WorkBuddy 协作上报（非原生镜像）；网页不能发送需求或停止客户端。'}:agentFor(client),capabilities:capabilities(client),sessionId:client.hub?.session.id||client.sessionId,binding:client.hub?{...client.hub.session,canControl:client.canControl,transport:client.hub.transport}:null,routing:follow.view(client),incomingSources:workBuddy?.incoming()||[],...(enableMultiAgentFollow?{subscriptions:[...(client.subscriptions?.values()||[])].map(h=>({id:h.session.id,title:h.session.title,provider:h.session.provider||adapter.descriptor?.id||'opencode',status:h.projection.value.status,selected:client.hub===h}))}:{}),run:client.hub?.projection.value||client.run};}
  function push(client){client.revision++;const data='event: snapshot\ndata: '+JSON.stringify(snapshot(client))+'\n\n';for(const res of client.streams){if(res.writableLength>512*1024){res.destroy();continue;}res.write(data);}}
  function rate(key,limit){const value=rates.get(key);if(!value||now()-value.start>=60000){rates.set(key,{start:now(),count:1});return;}if(++value.count>limit)fail(429,'请求过于频繁，请稍后重试');}
  function changedBindings(){onBindings([...hubs.values()].filter(h=>h.members.size).map(h=>({id:h.session.id,title:h.session.title,...(h.session.provider?{provider:h.session.provider}:{} ),...(enableMultiAgentFollow?{subscribed:true,selected:[...h.members].some(c=>c.active&&c.hub===h)}:{})})));follow.reconcile();}
  const sourceBusy=hub=>hub.inflightWrites>0||['queued','running','stopping','unknown'].includes(hub.projection.value.status)||hub.projection.value.questions?.length||hub.projection.value.approvals?.length;
  function restartDesktop(input,assertAuthorized=()=>{}) {
    if(!codexDesktop)fail(404,'桌面端切换未启用');
    if(input.instanceId!==instanceId)fail(409,'连接器实例已变化，请重新连接');
    return codexDesktop.restart({requestId:input.requestId,assertAllowed:()=>{
      if(closed)throw new CodexDesktopFailure(503,'连接器正在关闭');
      assertAuthorized();
    },assertCanRestart:()=>{
      if([...hubs.values()].some(h=>(h.session.provider==='codex'||h.adapter.descriptor?.id==='codex')&&sourceBusy(h)))
        throw new CodexDesktopFailure(409,'已绑定的 Codex 会话仍在执行、等待答复或状态未知，请处理完成后再切换桌面端');
    }});
  }
  function eviction(client,targetId){return [...(client.subscriptions||[])].find(([id,hub])=>id!==targetId&&(!sourceBusy(hub)||hub.session.provider==='workbuddy'))?.[1];}
  function canSwitch(client,target){return !enableMultiAgentFollow||client.subscriptions?.has(target.id)||!client.subscriptions||client.subscriptions.size<8||Boolean(eviction(client,target.id));}
  function retireHub(hub){const job=hub.close();cleanups.add(job);job.then(()=>cleanups.delete(job),()=>cleanups.delete(job));return job;}
  async function release(client,hub){if(!hub)return;hub.remove(client);hub.pending?.delete(client);if(!hub.members.size&&!hub.pending?.size){if(hubs.get(hub.session.id)===hub)hubs.delete(hub.session.id);await retireHub(hub);}}
  async function detach(client){const attached=new Set([client.hub,client.pendingHub,...(client.subscriptions?.values()||[])].filter(Boolean));client.hub=null;client.pendingHub=null;client.subscriptions?.clear();client.canControl=false;const jobs=[...attached].map(hub=>release(client,hub));changedBindings();await Promise.all(jobs);}
  function revokeExpired(){for(const[token,client]of clients)if(client.expires<now()){disconnected(client,'expired');client.active=false;clients.delete(token);for(const stream of client.streams)stream.end();follow.reconcile();void detach(client).catch(()=>{});}}
  async function bind(client,input,{isCurrent=()=>true}={}){
    const wb=workBuddy?.has(input.sessionId)===true;
    let native=adapter;if(!wb&&adapter.forSession){try{native=adapter.forSession(input.sessionId);}catch{fail(404,'该原生来源未知或不可用，不回退到其他Agent');}}
    if(!wb&&/^ses_wb_[a-f0-9]{32}$/.test(input.sessionId||''))fail(404,'WorkBuddy 协作任务未知或已过期，不能作为原生会话绑定');
    if(!wb&&!adapter.bindSession)fail(503,'当前适配器不支持共享会话');
    if(client.bindingBusy)fail(409,'上一次会话绑定尚未完成');
    if(typeof input.allowControl!=='boolean')fail(400,'请明确是否允许网页向该会话发送需求');
    if(wb&&input.allowControl)fail(403,'WorkBuddy 仅支持协作上报，网页不能控制客户端');
    if(client.run&&BUSY.has(client.run.status))fail(409,'请先结束隔离预览执行再绑定');
    if(!canSwitch(client,{id:input.sessionId}))fail(409,'已授权来源订阅已达8个且仍在执行，请等待完成后再切换');
    client.bindingBusy=true;const bindingEpoch=(client.bindingEpoch||0)+1;client.bindingEpoch=bindingEpoch;
    const authorized=()=>!closed&&client.active&&client.expires>=now()&&client.bindingEpoch===bindingEpoch&&isCurrent();
    try{
    const sourceHealth=!wb&&adapter.healthFor?await adapter.healthFor(native):null;
    if(native.descriptor?.id==='qwen'&&input.allowControl&&!nativeCapabilities(native,sourceHealth||await native.health()).submitPrompt)fail(409,'千问办公当前未开放网页发送');
    const session=wb?workBuddy.hub(input.sessionId).session:await native.bindSession(input.sessionId);if(!authorized())fail(401,'授权已失效');
    if(client.hub?.session.id===session.id){if(!input.allowControl)client.hub.cancelControl?.(client);client.canControl=input.allowControl;push(client);return snapshot(client);}
    let hub=hubs.get(session.id);
    if(!hub&&wb){hub=workBuddy.hub(session.id);hubs.set(session.id,hub);}
    if(!hub){
      const command=publisherCommand||'node '+JSON.stringify(fileURLToPath(new URL('../../publish.mjs',import.meta.url)));
      const instruction=`当前会话已由用户绑定快麦多维表格网页。你的公开回复、用户输入和工具状态会自动同步，禁止转发私有推理或密钥，不要重复发送收到的用户消息。\n当为快麦构建报表时，请主动逐步更新预览，而不是等最终长回复：使用本机命令 ${command} --session ${session.id} --file <事件JSON文件>。先运行该命令的 --help 查看白名单数据协议。命令只显示UI，不保存平台资源、不提升原工具权限。\n至少先发plan.updated，再逐项artifact.updated；页面可用page.section.updated逐块补齐、step.updated更新实际阶段、artifact.focus展示对应成果。示例：{"id":"唯一事件ID","type":"step.updated","payload":{"id":"read","label":"读取订单字段","status":"running"}}。不得把未完成调用或预览冒充已落库、发布或运行。普通回复也可输出完整的kmmdtable JSON小块作为兼容预览。`;
      const standard=`\n标准协议km-agent/1：${command} commands 查看指令映射。新建页面用resource.create，编辑用resource.edit，等待用work.status，必须有唯一事件ID。成果appearance/document独立于宿主样式。技能与公开阶段用activity.updated，禁止发布私有推理。已接收不等于浏览器应用：${command} receipt --session ${session.id} --id <事件ID>核验。工作区技能位于.agents/skills/km-agent-bridge/SKILL.md。`;
      hub=createSharedHub({adapter:native,session,instructionKey:'kmmdtable-bridge-'+instanceId.slice(0,8),instruction:instruction+standard+'\n请用公开commentary或phase说明当前动作，不转发私有推理。工具广播只含脱敏摘要；用户展开时由鉴权详情接口读取脱敏限长的请求与返回，不要把原始结果塞入activity或对话。没有公开来源的思考记录只展示耗时。',onChange:()=>{for(const member of hub.members)if(member.active){push(member);follow.tick(member);}}});
      hub.receipts=new Map();
      hub.pending=new Set();hubs.set(session.id,hub);hub.starting=hub.start();
    }
    client.pendingHub=hub;hub.pending.add(client);
    try{await hub.starting;}catch(error){
      if(client.pendingHub===hub)client.pendingHub=null;
      await release(client,hub);
      const provider=native.descriptor?.id;
      if(provider==='codex'&&error?.code==='CODEX_THREAD_IN_USE'){
        fail(409,'该 Codex 会话仍在另一个客户端打开。请在那里关闭这条会话，在 TUI 续接后再绑定。');
      }
      const label=provider==='codex'?'Codex':provider==='opencode'?'OpenCode':provider==='qwen'?'千问办公':'本地 Agent';
      fail(503,`${label} 原生事件通道未就绪，原会话保留`);
    }
    if(!authorized()){if(client.pendingHub===hub)client.pendingHub=null;if(client.hub!==hub&&!client.subscriptions?.has(hub.session.id))await release(client,hub);else hub.pending.delete(client);fail(401,'授权或跟随设置已变化');}
    const previous=client.hub;
    if(enableMultiAgentFollow){client.subscriptions||=new Map();if(!client.subscriptions.has(session.id)&&client.subscriptions.size>=8){const stale=eviction(client,session.id);if(!stale){client.pendingHub=null;await release(client,hub);fail(409,'已授权来源仍在执行，切换暂缓');}client.subscriptions.delete(stale.session.id);void release(client,stale).catch(()=>{});}client.subscriptions.set(session.id,hub);}
    if(previous&&previous!==hub)previous.cancelControl?.(client);
    client.pendingHub=null;hub.pending.delete(client);client.hub=hub;client.canControl=input.allowControl;hub.members.add(client);client.sessionId=null;client.run=null;if(previous&&previous!==hub&&(!enableMultiAgentFollow||previous.session.provider==='workbuddy')){client.subscriptions?.delete(previous.session.id);await release(client,previous);}changedBindings();push(client);return snapshot(client);
    }finally{client.bindingBusy=false;follow.tick(client);}
  }
  function authenticate(req,origin){const token=req.headers.authorization?.replace(/^Bearer /,'');const client=token&&clients.get(token);if(!client||!client.active||client.origin!==origin||client.expires<now())fail(401,'连接授权已失效，请重新配对');return client;}
  function makeClient(origin,websiteOrigin=origin){if(clients.size>=12)fail(409,'本次连接器授权数已达上限');const token=randomBytes(32).toString('base64url'),client={origin,active:true,expires:now()+8*3600e3,revision:0,sessionId:null,run:null,streams:new Set(),requests:new Map()};client.websiteOrigin=websiteOrigin;follow.init(client,autoTrust?.origin===origin);clients.set(token,client);connected(client);return{token,client};}
  function releaseDirectClient(token,reason='replaced'){const client=clients.get(token);if(!client)return;disconnected(client,reason);client.active=false;clearTimeout(client.timer);for(const stream of client.streams)stream.end();clients.delete(token);follow.reconcile();void detach(client).catch(()=>{});}
  async function body(req,keys,limit=20000){if(!req.headers['content-type']?.startsWith('application/json')||req.headers['x-km-agent']!=='1')fail(415,'需要受控的JSON请求');const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>limit)fail(413,'请求内容过长');chunks.push(chunk);}let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail(400,'JSON格式无效');}if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))fail(400,'请求字段不符合约定');return value;}
  function updateOutput(client,messages) {
    const run=client.run,artifacts=new Map();let plan=null;const warnings=[];
    const readable=[];
    for(const message of messages.slice(-40)) {
      if(message.role==='user'){readable.push({id:message.id,role:'user',text:message.text.slice(0,4000)});continue;}
      const parsed=M.parseOutput(message.text);if(parsed.plan)plan=parsed.plan;
      for(const artifact of parsed.artifacts)artifacts.set(artifact.id,artifact);
      warnings.push(...parsed.warnings);
      if(parsed.text)readable.push({id:message.id,role:'assistant',text:parsed.text.slice(0,14000)});
    }
    run.plan=plan;run.artifacts=[...artifacts.values()].slice(-12);run.warnings=warnings.slice(-5);
    // Use the canonical OpenCode timeline once its user inputs have been projected.
    run.messages=(readable.some(message=>message.role==='user')?readable:[...run.inputs,...readable]).slice(-48);
  }
  function schedule(client,action,delay){clearTimeout(client.timer);client.timer=setTimeout(()=>{client.timer=null;action();},delay);client.timer.unref?.();}
  function isCurrent(client,run){return !closed&&client.active&&client.run===run;}
  async function poll(client,run) {
    if(!isCurrent(client,run)||!BUSY.has(run.status))return;
    try {
      const value=await adapter.read(run.sessionId);if(!isCurrent(client,run)||!BUSY.has(run.status))return;
      const before=JSON.stringify(run);updateOutput(client,value.messages);run.tools=value.tools||[];run.model=value.model||null;
      run.status=run.stopRequested&&value.status==='running'?'stopping':value.status;run.error=value.status==='failed'?'OpenCode 本轮执行失败，请检查本地模型认证、额度或服务日志。':null;
       if(JSON.stringify(run)!==before)push(client);
       if(enableMultiAgentFollow&&!BUSY.has(run.status))follow.tick(client);
      if(BUSY.has(run.status)) {
        if(now()-run.startedAt>180000){await stop(client);return;}
        schedule(client,()=>poll(client,run),900);
      }
    } catch {if(!isCurrent(client,run))return;run.status='unknown';run.error='暂时无法读取 OpenCode，本轮结果未知；不会自动重新提交需求。';push(client);schedule(client,()=>poll(client,run),5000);}
  }
  async function execute(client,run) {
    const signal=client.abort.signal;
    let sessionId=client.sessionId;
    try {
      if(!sessionId)sessionId=await adapter.createSession();
      if(!isCurrent(client,run)||run.stopRequested||signal.aborted)return;
      client.sessionId=sessionId;run.sessionId=sessionId;
      await adapter.send(sessionId,run.prompt,{signal});
      if(!isCurrent(client,run)){await adapter.interrupt(sessionId).catch(()=>{});return;}
      if(run.stopRequested){await stop(client);return;}
      push(client);await poll(client,run);
    } catch(error){if(!isCurrent(client,run))return;if(error.code==='NOT_SUBMITTED'){run.status='interrupted';run.error=null;push(client);return;}run.status='unknown';run.error='OpenCode 请求未获完整确认。可能已接收，本原型不会自动重发；请先停止或在本地确认。';push(client);if(run.sessionId)schedule(client,()=>poll(client,run),5000);}
  }
  async function stop(client) {
    const run=client.run;if(!run||!BUSY.has(run.status))return;
    run.stopRequested=true;client.abort?.abort();clearTimeout(client.timer);
    if(run.mode==='demo'||!run.sessionId){run.status='interrupted';push(client);if(enableMultiAgentFollow)follow.tick(client);return;}
    run.status='stopping';push(client);
    try {const result=await adapter.interrupt(run.sessionId);if(!isCurrent(client,run)||!BUSY.has(run.status))return;run.status=result.interrupted?'interrupted':'unknown';run.error=result.interrupted?null:'停止请求已发送，尚未确认本轮终态。';push(client);if(enableMultiAgentFollow&&!BUSY.has(run.status))follow.tick(client);if(run.status==='unknown')schedule(client,()=>poll(client,run),900);}
    catch {if(!isCurrent(client,run)||!BUSY.has(run.status))return;run.status='unknown';run.error='停止结果未知，请在本地 OpenCode 确认。';push(client);}
  }
  function begin(client,mode,input) {
    if(!client.active||client.expires<now())fail(401,'连接授权已失效，请重新配对');
    if(client.requests.has(input.requestId))return client.requests.get(input.requestId);
    if(client.run&&BUSY.has(client.run.status))fail(409,'当前执行尚未结束，请先等待或停止');
    const previous=mode==='opencode'&&client.run?.mode==='opencode'?client.run:null;
    if(!previous)client.sessionId=null;
    const run={id:randomUUID(),mode,status:'running',prompt:input.text||'构建一个商品补货分析应用',startedAt:now(),plan:previous?.plan||null,artifacts:previous?.artifacts||[],messages:[],inputs:[...(previous?.inputs||[]),{id:randomUUID(),role:'user',text:input.text||'演示：构建商品补货分析应用'}],tools:[],warnings:[],error:null};
    run.messages=[...run.inputs];client.run=run;client.abort=new AbortController();
    const receipt={runId:run.id};client.requests.set(input.requestId,receipt);if(client.requests.size>64)client.requests.delete(client.requests.keys().next().value);
    push(client);
    if(mode==='opencode')void execute(client,run);
    else {
      const messages=[];let index=0;
      const step=()=>{if(!isCurrent(client,run)||run.status!=='running')return;messages.push({id:'demo-'+index,text:DEMO_STAGES[index++]});updateOutput(client,messages);if(index===DEMO_STAGES.length)run.status='completed';push(client);if(enableMultiAgentFollow&&run.status==='completed')follow.tick(client);if(run.status==='running')schedule(client,step,1400);};
      schedule(client,step,250);
    }
    return receipt;
  }
  follow=createFollowManager({adapter,autoTrust,clients:()=>clients.values(),bind,push,now,enableMultiAgentFollow,workBuddy:Boolean(workBuddy),canSwitch});
  const server=http.createServer(async(req,res)=>{
    const requestLog=observeRequest(req,res,{logger,instanceId,origins});
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    let writingClient=null,writingHub=null;
    try {
      const port=req.socket.localPort;let origin=req.headers.origin;
      if(req.headers.host!==`127.0.0.1:${port}`)fail(403,'本地连接器不接受此Host');
      revokeExpired();workBuddy?.sweep();
      const localEndpoint=`http://127.0.0.1:${port}`;
      if(desktopConnect&&await desktopConnect.handlePublic(req,res,{endpoint:localEndpoint,instanceId}))return;
      if(['/v1/local/codex/desktop/status','/v1/local/codex/desktop/restart'].includes(req.url)){
        if(!codexDesktop)fail(404,'桌面端切换未启用');
        if(req.method!=='POST'||origin!==undefined||!equal(req.headers['x-km-publisher']||'',publisherKey))fail(403,'只接受已授权的本机桌面端操作');
        rate('codex-desktop-local',120);
        const restart=req.url.endsWith('/restart'),input=await body(req,restart?['instanceId','requestId']:['instanceId']);
        if(input.instanceId!==instanceId)fail(409,'连接器实例已变化，请重新连接');
        return json(res,restart?202:200,{ok:true,data:restart?restartDesktop(input):codexDesktop.status()});
      }
      if(req.url?.startsWith('/v1/local/workbuddy/tasks/')){
        if(!workBuddy)fail(404,'WorkBuddy 协作上报未启用');
        const action=req.url.slice('/v1/local/workbuddy/tasks/'.length),keys={open:['requestId','title','workspaceId'],publish:['instanceId','taskId','event'],receipt:['instanceId','taskId','eventId'],finish:['instanceId','taskId','requestId','status','note'],heartbeat:['instanceId','taskId']};
        if(!Object.hasOwn(keys,action))fail(404,'接口不存在');
        if(req.method!=='POST'||origin!==undefined)fail(403,'WorkBuddy 只接受无Origin的本机协作请求');
        if(action==='open'&&!equal(req.headers['x-km-publisher']||'',publisherKey))fail(403,'WorkBuddy 本机注册授权无效');
        if(action!=='open'&&!req.headers['x-km-task-token'])fail(403,'WorkBuddy 需要该任务专属授权');
        rate('workbuddy:'+action,action==='open'?40:240);const observedOrder=action==='open'?nextSourceOrder():undefined,input=await body(req,keys[action]);
        return json(res,200,{ok:true,data:action==='open'?workBuddy.open(input,{observedOrder}):workBuddy[action](input,req.headers['x-km-task-token'])});
      }
      if(['/v1/local/publish','/v1/local/receipt'].includes(req.url)){
        if(req.method!=='POST'||origin||!equal(req.headers['x-km-publisher']||'',publisherKey))fail(403,'只接受已授权的本机Agent发布');
        rate('local-publisher',240);const input=await body(req,['sessionId','event','eventId']),hub=hubs.get(input.sessionId);
        if(workBuddy?.has(input.sessionId)||hub?.session.provider==='workbuddy')fail(403,'WorkBuddy 只接受任务专属发布和回执授权');
        if(!hub||!hub.members.size)fail(404,'该会话尚未被网页绑定，请先在前端选择会话');
        if(hub.adapter.capabilities?.publishUI===false)fail(403,'此会话只同步原生消息');
        if(req.url==='/v1/local/receipt')return json(res,200,{ok:true,data:hub.receipts.get(input.eventId)||{eventId:input.eventId,status:'unknown'}});
        try{const result=hub.publish(input.event);if(!hub.receipts.has(input.event.id)){hub.receipts.set(input.event.id,{eventId:input.event.id,status:'accepted',clients:[]});while(hub.receipts.size>100)hub.receipts.delete(hub.receipts.keys().next().value);}return json(res,200,{ok:true,data:{...result,accepted:true,delivery:hub.receipts.get(input.event.id).status,eventId:input.event.id}});}catch{fail(400,'UI事件未通过白名单或数据校验');}
      }
      // Browsers omit Origin on same-origin GETs. Only the authenticated desktop
      // window may use that form; CLI publishers and other websites stay unchanged.
      if(desktopConnect&&origin===undefined&&req.method==='GET'&&req.headers['sec-fetch-site']==='same-origin'){
        authenticate(req,localEndpoint);origin=localEndpoint;
      }
      if(!origins.has(origin)&&!(desktopConnect&&origin===localEndpoint))fail(403,'本地连接器不接受此来源');
      res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');
      if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-Km-Agent');res.setHeader('Access-Control-Allow-Private-Network','true');res.writeHead(204);res.end();return;}
      rate(origin+':requests',180);
      if(req.url==='/v1/connect/discover'&&req.method==='GET'){
        if(!desktopConnect?.direct)fail(404,'原页面连接入口未启用');
        return json(res,200,{ok:true,data:{service:'kuaimai-agent-connector',transport:'direct/1',endpoint:localEndpoint,instanceId}});
      }
      if(['/v1/connect/claim','/v1/connect/direct-resume','/v1/connect/direct-revoke'].includes(req.url)&&req.method==='POST'){
        if(!desktopConnect?.direct||!origins.has(origin))fail(403,'原页面连接未授权');
        const claim=req.url.endsWith('/claim'),revoke=req.url.endsWith('/direct-revoke');
        rate(origin+':direct-connect',60);
        const value=await body(req,claim?['state','verifier','instanceId']:['reconnectToken','instanceId']);
        if(value.instanceId!==instanceId)fail(409,'连接器实例已变化，请重新复制连接请求');
        let grant;
        try{
          if(revoke){releaseDirectClient(desktopConnect.direct.revoke({...value,origin}),'revoked');return json(res,200,{ok:true,data:null});}
          grant=desktopConnect.direct[claim?'claim':'resume']({...value,origin});
        }catch{fail(403,'本页接入授权无效或已过期，请重新复制连接请求');}
        if(!grant)return json(res,202,{ok:true,data:{pending:true}});
        releaseDirectClient(grant.previousClient);
        const {token,client}=makeClient(origin);requestLog.client(client);client.websiteOrigin=origin;
        client.expires=Math.min(client.expires,grant.expiresAt);
        desktopConnect.direct.attach(claim?grant.reconnectToken:value.reconnectToken,token);
        return json(res,200,{ok:true,data:{token,expiresAt:client.expires,snapshot:snapshot(client),...(claim?{reconnectToken:grant.reconnectToken}:{})}});
      }
      if(req.url==='/v1/health'&&req.method==='GET'){await checkHealth();return json(res,200,{ok:true,data:publicHealth(origin)});}
      if(req.url==='/v1/connect/exchange'&&req.method==='POST'){
        if(!desktopConnect)fail(404,'桌面连接入口未启用');
        rate(origin+':connect',10);const value=await body(req,['ticket','state','verifier','websiteOrigin']);
        let grant;try{grant=desktopConnect.consume({...value,requestOrigin:origin,endpoint:localEndpoint,instanceId});}catch{fail(403,'接入请求无效、已过期或不属于当前网页');}
        const {token,client}=makeClient(origin,grant.websiteOrigin);requestLog.client(client);
        return json(res,200,{ok:true,data:{token,expiresAt:client.expires,snapshot:snapshot(client),...(grant.reconnectToken?{reconnectToken:grant.reconnectToken}:{})}});
      }
      if(req.url==='/v1/connect/resume'&&req.method==='POST'){
        if(!desktopConnect?.resume)fail(404,'后台连接入口未启用');
        rate(origin+':connect',10);const value=await body(req,['reconnectToken','websiteOrigin']);
        let grant;try{grant=desktopConnect.resume({...value,requestOrigin:origin,endpoint:localEndpoint,instanceId});}catch{fail(403,'后台连接授权已失效，请重新复制连接请求');}
        const {token,client}=makeClient(origin,grant.websiteOrigin);requestLog.client(client);
        return json(res,200,{ok:true,data:{token,expiresAt:client.expires,snapshot:snapshot(client)}});
      }
      if(req.url==='/v1/handshake'&&req.method==='POST'){
        await body(req,[]);if(!autoTrust||autoTrust.origin!==origin)fail(403,'此来源未被本机启动器授权');rate(origin+':handshake',20);if(autoTrust.sessionId)await checkHealth();const{token,client}=makeClient(origin);requestLog.client(client);
        try{if(autoTrust.sessionId)await bind(client,{sessionId:autoTrust.sessionId,allowControl:autoTrust.allowControl===true});if(enableMultiAgentFollow&&client.follow.enabled){const latest=workBuddy?.incoming()[0];if(latest)await follow.offer({...latest,reason:'cached-task'},client);}await follow.ensure();return json(res,200,{ok:true,data:{token,expiresAt:client.expires,snapshot:snapshot(client)}});}catch(error){disconnected(client,'handshake_failed');client.active=false;clients.delete(token);follow.reconcile();await detach(client);throw error;}
      }
      if(req.url==='/v1/pair'&&req.method==='POST') {
        rate(origin+':pair',10);const value=await body(req,['code']);
        if(typeof value.code!=='string'||!/^\d{6}$/.test(value.code)||now()>codeExpires||!equal(value.code,code))fail(403,'配对码无效或已过期，请查看连接器终端中的最新配对码');
        revokeExpired();
        if(clients.size>=4)fail(409,'本次连接器配对数已达上限，请先撤销不用的连接');
        const token=randomBytes(32).toString('base64url'),client={origin,active:true,expires:now()+8*3600e3,revision:0,sessionId:null,run:null,streams:new Set(),requests:new Map()};
        follow.init(client,false);clients.set(token,client);connected(client);requestLog.client(client);code=String(randomInt(100000,1000000));codeExpires=now()+10*60e3;onPairCode(code);
        await checkHealth();return json(res,200,{ok:true,data:{token,expiresAt:client.expires,snapshot:snapshot(client)}});
      }
      if(!['/v1/snapshot','/v1/events','/v1/run','/v1/demo','/v1/stop','/v1/disconnect','/v1/reset','/v1/sessions','/v1/sources','/v1/bind','/v1/unbind','/v1/protocol','/v1/ui/ack','/v1/follow','/v1/tool/detail','/v1/files/search','/v1/session/new','/v1/questions','/v1/question/reply','/v1/question/reject','/v1/approvals','/v1/approval/reply','/v1/codex/desktop','/v1/codex/desktop/restart','/v1/qwen/desktop','/v1/qwen/desktop/ensure'].includes(req.url))fail(404,'接口不存在');
      const client=authenticate(req,origin);requestLog.client(client);
      if(['/v1/qwen/desktop','/v1/qwen/desktop/ensure'].includes(req.url)){
        if(!qwenDesktop)fail(404,'千问自动准备未启用，请更新本机连接器');
        if(req.url==='/v1/qwen/desktop'&&req.method==='GET')return json(res,200,{ok:true,data:qwenDesktop.status()});
        if(req.url!=='/v1/qwen/desktop/ensure'||req.method!=='POST')fail(405,'请求方法不支持');
        const input=await body(req,['instanceId','requestId']);
        if(input.instanceId!==instanceId)fail(409,'连接器实例已变化，请重新连接');
        if(typeof input.requestId!=='string')fail(400,'准备请求标识无效');
        const assertAllowed=()=>{if(!client.active||client.expires<now())fail(401,'千问准备授权已失效');};
        rate(origin+':qwen-prepare',20);
        return json(res,202,{ok:true,data:qwenDesktop.ensure({requestId:input.requestId,assertAllowed})});
      }
      if(['/v1/codex/desktop','/v1/codex/desktop/restart'].includes(req.url)){
        if(!codexDesktop)fail(404,'桌面端切换未启用');
        if(req.url==='/v1/codex/desktop'&&req.method==='GET')return json(res,200,{ok:true,data:codexDesktop.status()});
        if(req.url!=='/v1/codex/desktop/restart'||req.method!=='POST')fail(405,'请求方法不支持');
        const input=await body(req,['instanceId','requestId']);
        return json(res,202,{ok:true,data:restartDesktop(input,()=>{
          if(!client.active||client.expires<now())throw new CodexDesktopFailure(401,'桌面端操作授权已失效');
        })});
      }
      if(req.method==='POST'&&['/v1/run','/v1/session/new','/v1/question/reply','/v1/question/reject','/v1/approval/reply'].includes(req.url)
        &&(client.hub?.session.provider==='codex'||nativeFor(client).descriptor?.id==='codex')
        &&codexDesktop?.status().operation?.state==='running'
        &&codexDesktop.status().operation.action==='restart')fail(409,'桌面端正在切换，请完成后重新核验会话再发送');
      if(enableMultiAgentFollow&&req.method==='POST'&&['/v1/run','/v1/session/new','/v1/question/reply','/v1/question/reject','/v1/approval/reply'].includes(req.url)){writingClient=client;client.writesBusy=(client.writesBusy||0)+1;writingHub=client.hub;if(writingHub)writingHub.inflightWrites=(writingHub.inflightWrites||0)+1;}
      if(req.url==='/v1/approvals'&&req.method==='GET'){if(!capabilities(client).nativeApprovals)fail(409,'该来源不支持网页原生审批');if(!client.hub||client.hub.transport!=='connected')fail(409,'原生会话未连接');return json(res,200,{ok:true,data:{instanceId,sessionId:client.hub.session.id,approvals:client.hub.projection.value.approvals}});}
      if(req.url==='/v1/approval/reply'&&req.method==='POST'){
        const originalHub=client.hub,epoch=client.bindingEpoch,transportEpoch=originalHub?.transportEpoch,input=await body(req,['instanceId','sessionId','approvalId','decision']);
        const assertCurrent=()=>{if(!client.active||client.expires<now())fail(401,'授权已失效');if(input.instanceId!==instanceId||!originalHub||client.hub!==originalHub||client.bindingEpoch!==epoch||input.sessionId!==originalHub.session.id||originalHub.transport!=='connected'||originalHub.transportEpoch!==transportEpoch||client.bindingBusy)fail(409,'审批所属实例或会话已变化');if(!client.canControl)fail(403,'当前仅观察，未授权网页处理审批');};assertCurrent();
        if(!capabilities(client).nativeApprovals)fail(409,'该来源不支持网页原生审批');if(typeof input.approvalId!=='string'||!/^[\w:.-]{1,140}$/.test(input.approvalId)||!['accept','decline','cancel'].includes(input.decision))fail(400,'仅支持明确的本次允许、拒绝或取消');
        let receipt;try{receipt=await originalHub.answerApproval(client,input,{assertCurrent});}catch(error){assertCurrent();if(error instanceof Failure)throw error;fail(409,'审批答复未获确认，可能已由原生客户端处理；不会自动重试');}assertCurrent();return json(res,200,{ok:true,data:receipt});
      }
      if(req.url==='/v1/questions'&&req.method==='GET'){if(!capabilities(client).nativeQuestions)fail(409,'该适配器不支持原生问题');if(!client.hub||client.hub.transport!=='connected')fail(409,'原生会话未连接');return json(res,200,{ok:true,data:{instanceId,sessionId:client.hub.session.id,questions:client.hub.projection.value.questions}});}
      if(['/v1/question/reply','/v1/question/reject'].includes(req.url)&&req.method==='POST'){
        const originalHub=client.hub,epoch=client.bindingEpoch,reject=req.url.endsWith('/reject'),input=await body(req,reject?['instanceId','sessionId','questionId']:['instanceId','sessionId','questionId','answers'],128000);
        const assertCurrent=()=>{if(!client.active||client.expires<now())fail(401,'授权已失效');if(input.instanceId!==instanceId||!originalHub||client.hub!==originalHub||client.bindingEpoch!==epoch||input.sessionId!==originalHub.session.id||originalHub.transport!=='connected'||client.bindingBusy)fail(409,'问题所属实例或会话已变化或离线');if(!client.canControl)fail(403,'当前为观察模式，未授权回答或拒绝原生问题');};assertCurrent();
        if(!capabilities(client).nativeQuestions)fail(409,'该适配器不支持原生问题');if(typeof input.questionId!=='string'||!/^[\w:.-]{1,140}$/.test(input.questionId)||!reject&&(!Array.isArray(input.answers)||input.answers.length>32||input.answers.some(a=>!Array.isArray(a)||a.length>100||a.some(v=>typeof v!=='string'||v.length>8000))))fail(400,'问题或答案格式无效');
        let receipt;try{receipt=await originalHub.answerQuestion(client,input,{reject,assertCurrent});}catch(error){assertCurrent();if(error instanceof Failure)throw error;fail(409,'原生问题提交未获确认，可能已结束；不会作为聊天发送或自动重试，请核验原生会话');}assertCurrent();return json(res,200,{ok:true,data:receipt});
      }
      if(['/v1/files/search','/v1/session/new'].includes(req.url)&&req.method==='POST'){
        if(isWorkBuddy(client))fail(409,'WorkBuddy 协作来源不提供原生会话或工作区文件操作');
        const originalHub=client.hub,native=nativeFor(client),epoch=client.bindingEpoch,input=await body(req,req.url==='/v1/files/search'?['sessionId','query']:['sessionId','requestId']);
        const current=()=>Boolean(originalHub)&&client.active&&client.expires>=now()&&client.hub===originalHub&&client.bindingEpoch===epoch&&input.sessionId===originalHub.session.id;
        if(req.url==='/v1/files/search'){if(!current())fail(409,'搜索所属会话已变化');if(!capabilities(client).workspaceFiles||!native.searchWorkspaceFiles)fail(409,'该适配器未提供工作区文件搜索');let files;try{files=await native.searchWorkspaceFiles(originalHub.session.id,input.query||'');}catch{fail(400,'工作区文件搜索失败或范围已变化');}if(!current())fail(409,'搜索所属会话已变化');return json(res,200,{ok:true,data:files});}
        if(typeof input.requestId!=='string'||!/^[-\da-f]{36}$/.test(input.requestId))fail(400,'请求标识无效');client.creations||=new Map();let operation=client.creations.get(input.requestId);
        if(operation){if(operation.source!==input.sessionId)fail(409,'请求标识不能用于其他来源');await operation.promise;return json(res,200,{ok:true,data:{...snapshot(client),createdSessionId:operation.createdId}});}
        if(!current())fail(409,'新建来源已变化');if(!client.canControl)fail(403,'当前为观察模式，请先明确允许网页控制');if(!capabilities(client).newSession||!native.createSharedSession)fail(409,'该适配器不支持原生新会话');if(client.newSessionBusy||client.bindingBusy)fail(409,'会话操作尚未完成');client.newSessionBusy=true;follow.pin(client);operation={source:input.sessionId,createdId:null,promise:null};
        operation.promise=(async()=>{try{const created=await native.createSharedSession(originalHub.session.id);operation.createdId=created.id;if(!current())fail(409,'新会话可能已创建，但来源已变化，未切换');await bind(client,{sessionId:created.id,allowControl:true});if(!client.active||client.hub?.session.id!==created.id)fail(409,'新会话已创建但绑定发生变化');return created;}finally{client.newSessionBusy=false;}})();client.creations.set(input.requestId,operation);while(client.creations.size>20)client.creations.delete(client.creations.keys().next().value);await operation.promise;return json(res,200,{ok:true,data:{...snapshot(client),createdSessionId:operation.createdId}});
      }
      if(req.url==='/v1/protocol'&&req.method==='GET')return json(res,200,{ok:true,data:contract()});
      if(req.url==='/v1/ui/ack'&&req.method==='POST'){const originalHub=client.hub,epoch=client.bindingEpoch,input=await body(req,['sessionId','eventId','status','detail']);if(!client.active||client.expires<now())fail(401,'授权已失效');if(!originalHub||client.hub!==originalHub||client.bindingEpoch!==epoch||input.sessionId!==originalHub.session.id)fail(409,'回执会话已变化');const receipt=originalHub.receipts.get(input.eventId);if(!receipt||!['applied','deferred','failed'].includes(input.status))fail(400,'回执无法关联当前会话');receipt.status=input.status;receipt.clients=[{status:input.status,detail:(isWorkBuddy(client)?redactText(input.detail||'',true,{complete:true}):String(input.detail||'')).slice(0,160),at:now()}];return json(res,200,{ok:true,data:{recorded:true}});}
      if(req.url==='/v1/tool/detail'&&req.method==='POST'){
        if(isWorkBuddy(client))fail(409,'WorkBuddy 协作上报不提供原生工具详情');
        const originalHub=client.hub,epoch=client.bindingEpoch,transportEpoch=originalHub?.transportEpoch,input=await body(req,['sessionId','toolId']);
        const assertCurrent=()=>{if(!client.active||client.expires<now())fail(401,'授权已失效');if(!originalHub||client.hub!==originalHub||client.bindingEpoch!==epoch||input.sessionId!==originalHub.session.id||originalHub.transport!=='connected'||originalHub.transportEpoch!==transportEpoch)fail(409,'详情所属会话或原生连接已变化，未返回内容');};assertCurrent();
        const native=nativeFor(client);if(typeof input.toolId!=='string'||!/^[\w:.-]{1,140}$/.test(input.toolId))fail(400,'工具标识无效');if(!originalHub.projection.value.activities.some(a=>a.id==='tool:'+input.toolId&&['tool','skill'].includes(a.kind)))fail(404,'当前会话没有此工具记录');if(!capabilities(client).toolDetailFetch||!native.readToolDetail)fail(409,'该适配器未提供工具详情');
        let detail;try{detail=await native.readToolDetail(originalHub.session.id,input.toolId);}catch{assertCurrent();fail(409,'详情读取失败或作用域已变化，未返回内容');}assertCurrent();if(!detail||detail.toolId!==input.toolId)fail(404,'工具详情已过期或不可用，请重连核验');return json(res,200,{ok:true,data:detail});
      }
      if(['/v1/sessions','/v1/sources'].includes(req.url)&&req.method==='GET'){
        if(req.url==='/v1/sources'&&!workBuddy&&!enableMultiAgentFollow)fail(404,'接口不存在');
        if(!workBuddy&&!enableMultiAgentFollow){if(!adapter.listSessions)fail(503,'适配器不支持共享会话');return json(res,200,{ok:true,data:await adapter.listSessions()});}
        let primary=[],status='available';try{if(!adapter.listSessions)throw Error();primary=await adapter.listSessions();if(!Array.isArray(primary))throw Error();}catch(error){logger.error('agent.sessions_failed',{instanceId,requestId:requestLog.requestId,error});primary=[];status='unavailable';}
        const provider=adapter.descriptor?.id||'opencode',primarySource={provider,status,adapter:publicHealth().adapter,capabilities:publicHealth().capabilities,...(status==='unavailable'?{message:'原生会话列表暂不可用；未将失败表示为空列表成功。'}:{})};
        const sources=[...(adapter.sourceDiagnostics?.()||[primarySource]),...(workBuddy?[{provider:'workbuddy',status:'available',adapter:WORKBUDDY_ADAPTER,capabilities:WORKBUDDY_CAPABILITIES}]:[])],sessions=[...primary.map(s=>({...s,provider:s.provider||provider,status:hubs.get(s.id)?.projection.value.status||s.status||'unknown',adapter:s.adapter||publicHealth().adapter,capabilities:s.capabilities||publicHealth().capabilities})),...(workBuddy?.list()||[])];
        return json(res,200,{ok:true,data:req.url==='/v1/sources'?{sessions,sources}:sessions,...(req.url==='/v1/sessions'?{sources}:{})});
      }
      if(req.url==='/v1/bind'&&req.method==='POST'){const input=await body(req,['sessionId','allowControl']);if(workBuddy?.has(input.sessionId)&&input.allowControl===true)fail(403,'WorkBuddy 仅支持协作上报，网页不能控制客户端');follow.pin(client);return json(res,200,{ok:true,data:await bind(client,input)});}
      if(req.url==='/v1/follow'&&req.method==='POST'){const input=await body(req,['enabled']);if(typeof input.enabled!=='boolean')fail(400,'跟随设置须为布尔值');if(!follow.supported||isWorkBuddy(client)&&!enableMultiAgentFollow)fail(409,'此适配器不支持自动发现');follow.set(client,input.enabled);return json(res,200,{ok:true,data:snapshot(client)});}
      if(req.url==='/v1/snapshot'&&req.method==='GET'){if(client.hub&&!isWorkBuddy(client)&&adapter.healthFor)await adapter.healthFor(nativeFor(client));else await checkHealth();return json(res,200,{ok:true,data:snapshot(client)});}
      if(req.url==='/v1/events'&&req.method==='GET') {
        if(client.streams.size>=3)fail(429,'实时连接数过多');
        const streamId=randomUUID(),streamStarted=performance.now();
        logger.info('stream.opened',{...requestLog.metadata,streamId,transport:'sse'});
        res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive'});client.streams.add(res);streams.add(res);
        res.write('event: snapshot\ndata: '+JSON.stringify(snapshot(client))+'\n\n');
        const timer=setInterval(()=>{if(client.expires<now()){res.end();return;}res.write(': heartbeat\n\n');},10000);timer.unref();
        res.on('close',()=>{clearInterval(timer);client.streams.delete(res);streams.delete(res);logger.info('stream.closed',{...requestLog.metadata,streamId,transport:'sse',durationMs:Math.round((performance.now()-streamStarted)*100)/100,reason:closed?'service_stopped':client.logDisconnected?'client_disconnected':'transport_closed'});});return;
      }
      if(req.method!=='POST')fail(405,'请求方法不支持');
      if(req.url==='/v1/run'||req.url==='/v1/demo') {
        const originalHub=client.hub,originalEpoch=client.bindingEpoch,originalTransportEpoch=client.hub?.transportEpoch;
        if(req.url==='/v1/run'&&!originalHub&&autoTrust?.origin===client.origin&&!autoTrust.sessionId)fail(403,'无会话入口仅观察，请先明确绑定原生会话并授权控制');
        if(req.url==='/v1/run'&&originalHub&&!client.canControl)fail(403,'此绑定仅可观察，尚未授权网页输入');
        const value=await body(req,req.url==='/v1/run'?['requestId','text','sessionId','uploads','references','pageContext']:['requestId'],req.url==='/v1/run'?FILE_LIMITS.body:20000);
        if(typeof value.requestId!=='string'||!/^[-\da-f]{36}$/.test(value.requestId))fail(400,'请求标识无效');
        if(req.url==='/v1/run'){
          if(value.pageContext!==undefined){
            try{value.pageContext=normalizePageContext(value.pageContext,client.origin);}catch(error){fail(400,error.message);}
            if(!originalHub)fail(409,'页面上下文需要明确绑定的原生会话');
          }
          if(typeof value.text!=='string'||value.text.length>4000||!value.text.trim()&&!value.uploads?.length&&!value.references?.length)fail(400,'请输入需求或添加附件');if(!Array.isArray(value.references||[])||(value.references||[]).some(p=>typeof p!=='string'||p.length>500)||(value.uploads||[]).length+(value.references||[]).length>FILE_LIMITS.count)fail(400,'附件或引用格式无效');try{normalizeUploads(value.uploads||[]);}catch(error){fail(400,error.message);}if(!value.text.trim())value.text='请查看附件。';
          if(originalHub&&adapter.healthFor)await adapter.healthFor(nativeFor(client));else await checkHealth();if(!agentFor(client).ready)fail(503,'当前原生来源未就绪，未发送需求');if(originalHub&&!capabilities(client).submitPrompt)fail(409,'当前原生来源未开放网页发送能力');if((value.uploads?.length||value.references?.length)&&!capabilities(client).attachments)fail(409,'当前原生来源尚不支持此附件合同，未发送');
        }
        if(value.pageContext&&!capabilities(client).pageContext)fail(409,'当前 Agent 或连接器不支持独立页面上下文，请更新后重新连接；本条需求未发送');
        if(!client.active||client.expires<now())fail(401,'授权已失效');
        if(client.hub!==originalHub||client.bindingEpoch!==originalEpoch||(value.sessionId&&originalHub?.session.id!==value.sessionId))fail(409,'绑定已变化，原需求未发送；请核对当前会话后重新操作');
        if(client.hub){
          if(req.url==='/v1/demo')fail(409,'共享会话不插入模拟过程；解除绑定后可单独体验演示');
          if(!client.canControl)fail(403,'此绑定仅可观察，尚未授权网页输入');
          const assertSubmissionCurrent=()=>{if(!client.active||client.expires<now())fail(401,'发送授权已失效');if(client.hub!==originalHub||client.bindingEpoch!==originalEpoch||originalHub.transport!=='connected'||originalHub.transportEpoch!==originalTransportEpoch||client.bindingBusy)fail(409,'发送所属来源或原生连接已变化');if(!client.canControl)fail(403,'网页控制授权已撤回');};
          try{assertSubmissionCurrent();const receipt=await originalHub.submit(client,value,{assertCurrent:assertSubmissionCurrent});assertSubmissionCurrent();return json(res,202,{ok:true,data:receipt});}catch(error){requestLog.error(error);if(error?.code==='NOT_SUBMITTED'&&error.reason==='native_prompt_whitespace')fail(409,'千问当前接口会移除消息首尾空白，本条消息未发送。请确认并调整输入后再发送。');if(error?.code==='NOT_SUBMITTED'&&error.reason==='page_context_unsupported')fail(409,'千问当前接口尚不支持独立页面上下文，本条消息未发送。');if(error?.code==='NOT_SUBMITTED'&&error.reason==='busy')fail(409,'千问办公本轮仍在运行，消息未发送。请等本轮结束后再发送。');if(error?.code==='NOT_SUBMITTED')fail(409,'发送前会话或控制授权已变化，本条消息未提交；请核对后再操作');fail(409,'需求提交未获完整确认，不会自动重发；请核验本地会话');}
        }
        if(value.uploads?.length||value.references?.length)fail(409,'附件只支持已绑定的原生共享会话');
        return json(res,202,{ok:true,data:begin(client,req.url==='/v1/demo'?'demo':'opencode',value)});
      }
      const actionHub=client.hub,actionEpoch=client.bindingEpoch,actionTransportEpoch=client.hub?.transportEpoch;
      const actionInput=await body(req,req.url==='/v1/stop'?['instanceId','sessionId']:[]);
      if(req.url==='/v1/stop'&&(client.hub!==actionHub||client.bindingEpoch!==actionEpoch||actionHub?.transportEpoch!==actionTransportEpoch))fail(409,'停止请求所属来源或连接已变化，未停止新来源');
      if(req.url==='/v1/stop'&&(actionInput.instanceId!==undefined&&actionInput.instanceId!==instanceId||actionInput.sessionId!==undefined&&actionInput.sessionId!==actionHub?.session.id))fail(409,'停止请求指定的来源已变化，不停止当前来源');
      if(req.url==='/v1/unbind'){follow.pin(client);client.bindingEpoch=(client.bindingEpoch||0)+1;await detach(client);push(client);return json(res,200,{ok:true,data:snapshot(client)});}
      if(req.url==='/v1/stop'&&actionHub){if(!client.canControl)fail(403,'仅观察绑定不能中断执行');if(!capabilities(client).cancelRun)fail(409,'此来源不支持停止');try{await actionHub.stop();}catch{fail(409,'停止未获原生确认或连接已变化，不重试');}if(!client.active||client.expires<now()||client.hub!==actionHub||client.bindingEpoch!==actionEpoch||actionHub.transportEpoch!==actionTransportEpoch)fail(409,'停止结果属于旧来源，未用于当前来源');return json(res,200,{ok:true,data:snapshot(client)});}
      if(req.url==='/v1/reset'&&client.hub)fail(409,'共享会话不自动新建或清空；请在连接面板更换绑定');
      if(req.url==='/v1/stop'){await stop(client);return json(res,200,{ok:true,data:snapshot(client)});}
      if(req.url==='/v1/reset'){if(client.run&&BUSY.has(client.run.status))fail(409,'执行中不能新建会话');client.run=null;client.sessionId=null;push(client);return json(res,200,{ok:true,data:snapshot(client)});}
      if(req.url==='/v1/disconnect'){disconnected(client,'requested');client.active=false;clearTimeout(client.timer);for(const stream of client.streams)stream.end();clients.delete(req.headers.authorization.slice(7));follow.reconcile();if(client.hub||client.pendingHub)void detach(client).catch(()=>{});else void stop(client).catch(()=>{});return json(res,200,{ok:true,data:null});}
      fail(404,'接口不存在');
    }catch(error){requestLog.error(error);const known=error instanceof Failure||error instanceof WorkBuddyFailure||error instanceof CodexDesktopFailure||error instanceof QwenDesktopFailure;if(!res.headersSent)json(res,known?error.status:500,{ok:false,error:{message:known?error.message:'本地连接器请求失败，请在本地确认服务状态',...(error instanceof WorkBuddyFailure&&error.code==='WORKBUDDY_NOT_READY'?{code:error.code}:{})}});else res.end();}
    finally{if(writingHub)writingHub.inflightWrites--;if(writingClient){writingClient.writesBusy--;follow.tick(writingClient);}}
  });
  server.requestTimeout=10000;server.headersTimeout=10000;
  const leaseTimer=setInterval(()=>{revokeExpired();workBuddy?.sweep();},10000);leaseTimer.unref();
  async function close(){if(closed)return;closed=true;desktopConnect?.clear();desktopConnect?.direct?.clear();follow.close();clearInterval(leaseTimer);await codexDesktop?.close();await qwenDesktop?.close();for(const client of clients.values()){disconnected(client,'service_stopped');client.abort?.abort();clearTimeout(client.timer);if(client.run?.sessionId&&BUSY.has(client.run?.status))void adapter.interrupt?.(client.run?.sessionId).catch(()=>{});client.active=false;}const active=[...hubs.values()].map(retireHub);hubs.clear();await Promise.all([...active,...cleanups]);workBuddy?.close();await adapter.close?.();for(const res of streams)res.end();if(server.listening){const stopped=new Promise(resolve=>server.close(resolve));server.closeAllConnections();await stopped;}}
  return {server,close,instanceId};
}
