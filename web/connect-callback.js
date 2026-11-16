(() => {
  'use strict';
  const params=new URLSearchParams(location.hash.slice(1));history.replaceState(null,'',location.pathname);
  const data=Object.fromEntries(params),status=document.getElementById('status'),close=document.getElementById('close');
  try{
    if([...params.keys()].length!==4||!['state','endpoint','instanceId','ticket'].every(k=>params.getAll(k).length===1))throw Error();
    const endpoint=new URL(data.endpoint);
    if(endpoint.origin!==data.endpoint||endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||Number(endpoint.port)<1024||endpoint.username||endpoint.password||!/^[\w-]{43}$/.test(data.state)||!/^[\w-]{43}$/.test(data.ticket)||!/^[\w:.-]{1,140}$/.test(data.instanceId))throw Error();
    const key='km-agent.pending.'+data.state,pending=JSON.parse(localStorage.getItem(key)||'null');
    if(!pending||!Number.isFinite(pending.created)||Date.now()-pending.created>Math.min(Number(pending.ttl)||120000,1800000)||pending.created>Date.now()+1000)throw Error();
    const channel=new BroadcastChannel('km-agent-connect-'+data.state);channel.postMessage(data);localStorage.setItem(key+'.result',JSON.stringify(data));setTimeout(()=>channel.close(),500);
    status.textContent='接入信息已返回。请回到原网页，保留本机连接窗口即可。';close.hidden=false;close.onclick=()=>window.close();
  }catch{status.textContent='未找到对应的接入请求。请回到发起请求的浏览器配置中，重新点击“接入”。';}
})();
