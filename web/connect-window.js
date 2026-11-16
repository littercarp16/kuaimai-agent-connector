(() => {
  'use strict';
  const params = new URLSearchParams(location.hash.slice(1)), relayId = params.get('state'), websiteOrigin = params.get('origin'), instanceId = params.get('instanceId');
  history.replaceState(null, '', location.pathname);
  const title = document.getElementById('title'), status = document.getElementById('status'), button = document.getElementById('disconnect');
  document.getElementById('website').textContent = websiteOrigin || '';
  const parent = window.opener, requests = new Map(); let state = relayId, token = '', connecting = false, closed = false, epoch = 0, releasing = Promise.resolve();
  const reconnectKey = 'km-agent.reconnect.' + websiteOrigin;
  const allowed = new Set(['/v1/health','/v1/snapshot','/v1/events','/v1/run','/v1/stop','/v1/disconnect','/v1/reset','/v1/sessions','/v1/sources','/v1/bind','/v1/unbind','/v1/protocol','/v1/ui/ack','/v1/follow','/v1/tool/detail','/v1/files/search','/v1/session/new','/v1/questions','/v1/question/reply','/v1/question/reject','/v1/approvals','/v1/approval/reply','/v1/codex/desktop','/v1/codex/desktop/restart']);
  const send = value => {try{parent?.postMessage({ scope:'km-agent/window', state, ...value }, websiteOrigin);}catch{}};
  const fail = message => { title.textContent='连接未完成';status.textContent=message;send({type:'failure',message}); };
  try { const url=new URL(websiteOrigin);if(url.origin!==websiteOrigin||!['http:','https:'].includes(url.protocol)||!parent||!/^[\w-]{43}$/.test(state||''))throw Error(); }
  catch { fail('请从已获授权的网页点击接入，不要直接打开此地址。');return; }
  function releaseClient(value) {
    if(!value)return Promise.resolve();
    return fetch('/v1/disconnect',{method:'POST',headers:{'X-Km-Agent':'1','Content-Type':'application/json',Authorization:'Bearer '+value},body:'{}',keepalive:true,signal:AbortSignal.timeout(2000)}).catch(()=>{});
  }
  function disconnect(forget=false) {
    ++epoch;connecting=false;
    for(const controller of requests.values())controller.abort();requests.clear();
    const old=token;token='';releasing=releasing.then(()=>releaseClient(old));
    if(forget){closed=true;clearInterval(offers);localStorage.removeItem(reconnectKey);send({type:'closed',message:'已断开网页，请重新接入'});button.hidden=true;}
    title.textContent=forget?'已断开网页':'等待网页恢复';
    status.textContent=forget?'回到网页重新接入。':'网页刷新后将自动恢复连接，请保留此窗口。';
    return releasing;
  }
  function savedGrant(){try{const saved=JSON.parse(localStorage.getItem(reconnectKey)||'null');return saved?.instanceId===instanceId&&(!saved.expiresAt||saved.expiresAt>Date.now())?saved:null;}catch{return null;}}
  function offer(){if(!closed&&parent&&!parent.closed&&savedGrant())parent.postMessage({scope:'km-agent/available',relayId,instanceId},websiteOrigin);}
  const offers=setInterval(offer,500);
  button.onclick=()=>void disconnect(true);
  addEventListener('pagehide',()=>{clearInterval(offers);send({type:'closed'});void disconnect();});
  addEventListener('message',async event=>{
    if(event.source!==parent||event.origin!==websiteOrigin||event.data?.scope!=='km-agent/website'||closed)return;
    const message=event.data;
    if(message.type==='reattach'){
      if(message.relayId!==relayId||!/^[\w-]{43}$/.test(message.state||'')||connecting)return;
      state=message.state;await disconnect();send({type:'ready'});return;
    }
    if(message.state!==state)return;
    if(message.type==='detach'){await disconnect();return;}
    if(message.type==='init'&&!token&&!connecting){
      connecting=true;const mine=++epoch;
      try{
        await releasing;
        let reconnectToken;
        if(message.resume){const saved=savedGrant();if(!saved)throw Error('后台服务已变化，请回到网页重新复制连接请求');reconnectToken=saved.token;}
        const response=await fetch(message.resume?'/v1/connect/resume':'/v1/connect/exchange',{method:'POST',headers:{'X-Km-Agent':'1','Content-Type':'application/json'},body:JSON.stringify(message.resume?{reconnectToken,websiteOrigin}:{ticket:message.ticket,state,verifier:message.verifier,websiteOrigin}),signal:AbortSignal.timeout(10000)});
        const result=await response.json();
        if(!response.ok||!result.ok||result.data?.snapshot?.instanceId!==instanceId)throw Error('本机授权校验失败，请回到网页重新接入。');
        if(mine!==epoch||closed){await releaseClient(result.data.token);return;}
        token=result.data.token;title.textContent='网页已连接';status.textContent='可以返回网页继续使用。请保留此连接窗口。';button.hidden=false;
        if(result.data.reconnectToken)try{localStorage.setItem(reconnectKey,JSON.stringify({instanceId,token:result.data.reconnectToken,expiresAt:result.data.expiresAt}));}catch{}
        send({type:'connected',instanceId,relayId,resumable:!!savedGrant()});
      }catch(error){if(mine===epoch&&!closed)fail(error.message||'本机授权未完成');}finally{if(mine===epoch)connecting=false;}
      return;
    }
    if(message.type==='close'){await disconnect(true);return;}
    if(message.type==='abort'){requests.get(message.id)?.abort();return;}
    if(message.type!=='request'||!token||typeof message.id!=='string'||message.id.length>100||requests.has(message.id))return;
    if(!allowed.has(message.path)||!['GET','POST'].includes(message.method)||requests.size>=32){send({type:'error',id:message.id,message:'请求路径、方法或并发数超出连接窗口范围'});return;}
    if(message.body!==undefined&&(typeof message.body!=='string'||new TextEncoder().encode(message.body).length>9*1024*1024)){send({type:'error',id:message.id,message:'请求内容超过连接窗口大小限制'});return;}
    const requestState=state,reply=value=>{if(state===requestState)send(value);};
    const controller=new AbortController();requests.set(message.id,controller);
    try{
      const response=await fetch(message.path,{method:message.method,headers:{'X-Km-Agent':'1',Authorization:'Bearer '+token,...(message.body===undefined?{}:{'Content-Type':'application/json'})},body:message.body,credentials:'omit',cache:'no-store',redirect:'error',signal:controller.signal});
      reply({type:'headers',id:message.id,status:response.status,contentType:response.headers.get('content-type')||'application/json'});
      const reader=response.body?.getReader();if(reader)while(true){const chunk=await reader.read();if(chunk.done)break;reply({type:'chunk',id:message.id,chunk:chunk.value});}
      reply({type:'end',id:message.id});
    }catch{reply({type:'error',id:message.id,message:'本机请求已中止或连接中断'});}
    finally{if(requests.get(message.id)===controller)requests.delete(message.id);}
  });
  send({type:'ready'});
})();
