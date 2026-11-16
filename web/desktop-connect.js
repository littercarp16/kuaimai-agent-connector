/* Standalone browser SDK. It never scans ports or receives the bridge publisher key. */
(() => {
  'use strict';
  const encode = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const random = () => encode(crypto.getRandomValues(new Uint8Array(32)));
  const randomUUID = () => {
    const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
    const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  };
  // SHA-256 fallback for the explicitly supported HTTP development sites, where
  // SubtleCrypto is unavailable. getRandomValues still supplies all entropy.
  function sha256(text) {
    const data=new TextEncoder().encode(text),length=(data.length+9+63)&~63,buffer=new Uint8Array(length),view=new DataView(buffer.buffer);
    buffer.set(data);buffer[data.length]=128;view.setUint32(length-4,data.length*8);
    const k=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    const h=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19],w=new Uint32Array(64),rotr=(v,n)=>(v>>>n)|(v<<(32-n));
    for(let offset=0;offset<length;offset+=64){
      for(let i=0;i<16;i++)w[i]=view.getUint32(offset+i*4);
      for(let i=16;i<64;i++){const a=w[i-15],b=w[i-2];w[i]=(w[i-16]+(rotr(a,7)^rotr(a,18)^(a>>>3))+w[i-7]+(rotr(b,17)^rotr(b,19)^(b>>>10)))>>>0;}
      let[a,b,c,d,e,f,g,z]=h;
      for(let i=0;i<64;i++){const t1=(z+(rotr(e,6)^rotr(e,11)^rotr(e,25))+((e&f)^(~e&g))+k[i]+w[i])>>>0,t2=((rotr(a,2)^rotr(a,13)^rotr(a,22))+((a&b)^(a&c)^(b&c)))>>>0;z=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}
      [a,b,c,d,e,f,g,z].forEach((v,i)=>h[i]=(h[i]+v)>>>0);
    }
    const output=new Uint8Array(32),out=new DataView(output.buffer);h.forEach((v,i)=>out.setUint32(i*4,v));return encode(output);
  }
  const browserName = () => /Edg\//.test(navigator.userAgent)?'edge':/Firefox\//.test(navigator.userAgent)?'firefox':/Chrome\//.test(navigator.userAgent)?'chrome':/Safari\//.test(navigator.userAgent)?'safari':'default';
  function validDescriptor(value,state){
    try{const u=new URL(value.endpoint);return value.state===state&&u.origin===value.endpoint&&u.protocol==='http:'&&u.hostname==='127.0.0.1'&&Number(u.port)>=1024&&!u.username&&!u.password&&/^[\w:.-]{1,140}$/.test(value.instanceId)&&/^[\w-]{43}$/.test(value.ticket);}catch{return false;}
  }
  function connect({onStatus=()=>{},timeoutMs=120000,launch,resume,signal,beforeOpen}={}) {
    if(!['http:','https:'].includes(location.protocol)||!crypto?.getRandomValues)return Promise.reject(Error('请从受支持的网页打开本机连接器'));
    const origin=location.origin,state=random(),verifier=random(),challenge=sha256(verifier),key='km-agent.pending.'+state;
    const url='km-agent://connect?'+new URLSearchParams({origin,callback:origin+'/agent/connect-callback.html',state,challenge,browser:browserName()});
    beforeOpen?.(url);
    const popup=window.open('about:blank','km-agent-'+state,'popup,width=480,height=500');
    if(!popup)return Promise.reject(Error('请允许此网站打开连接窗口，然后重新点击接入'));
    popup.document.title='正在打开快麦连接器';popup.document.body.textContent='正在打开本机连接器，请在 macOS 确认网页来源。';
    let descriptor=null,settled=false,closed=false,channel,deadline,watch,sequence=0;
    const requests=new Map();
    const send=value=>{if(descriptor&&!popup.closed)popup.postMessage({scope:'km-agent/website',state,...value},descriptor.endpoint);};
    const erase=()=>{try{localStorage.removeItem(key);localStorage.removeItem(key+'.result');}catch{}};
    let resolveConnect,rejectConnect;
    const result=new Promise((resolve,reject)=>{resolveConnect=resolve;rejectConnect=reject;});
    function cleanup(message){
      if(closed)return;closed=true;clearTimeout(deadline);clearInterval(watch);channel?.close();erase();removeEventListener('message',onMessage);removeEventListener('storage',onStorage);removeEventListener('pagehide',onPageHide);
      for(const request of requests.values()){request.reject?.(Error(message));try{request.controller?.error(Error(message));}catch{}request.detach?.();}requests.clear();
      if(!settled){settled=true;rejectConnect(Error(message));}onStatus(message);
      signal?.removeEventListener('abort',abort);
    }
    function abort(){cleanup('连接准备已取消');popup.close();}
    function receive(value){
      if(closed||descriptor||!validDescriptor(value,state))return;
      descriptor=value;erase();channel?.close();onStatus('正在连接本机服务…');
      popup.location.href=descriptor.endpoint+'/connect#'+new URLSearchParams({state,origin,instanceId:descriptor.instanceId});
    }
    function onStorage(event){if(event.key===key+'.result'&&event.newValue)try{receive(JSON.parse(event.newValue));}catch{}}
    function onPageHide(){send({type:'close'});cleanup('网页已关闭');try{popup.close();}catch{}}
    function onMessage(event){
      if(closed||!descriptor||event.source!==popup||event.origin!==descriptor.endpoint||event.data?.scope!=='km-agent/window'||event.data.state!==state)return;
      const message=event.data;
      if(message.type==='ready'){send({type:'init',ticket:descriptor.ticket,verifier,resume:Boolean(resume)});return;}
      if(message.type==='connected'&&!settled&&message.instanceId===descriptor.instanceId){
        settled=true;clearTimeout(deadline);onStatus('本机连接器已接入');
        resolveConnect({endpoint:descriptor.endpoint,instanceId:descriptor.instanceId,token:'desktop-relay-'+state,fetch:relayFetch,close(){send({type:'close'});cleanup('已断开本机连接');popup.close();}});return;
      }
      if(message.type==='failure'||message.type==='closed'){cleanup(message.message||'本机连接窗口已关闭，请重新接入');return;}
      const pending=requests.get(message.id);if(!pending)return;
      if(message.type==='headers'&&!pending.controller){
        if(!Number.isInteger(message.status)||message.status<200||message.status>599){pending.reject(Error('Invalid relay response'));return;}
        const stream=new ReadableStream({start(controller){pending.controller=controller;},cancel(){send({type:'abort',id:message.id});pending.detach?.();requests.delete(message.id);}});
        pending.resolve(new Response(stream,{status:message.status,headers:{'Content-Type':message.contentType||'application/json'}}));
      }else if(message.type==='chunk'&&pending.controller&&message.chunk instanceof Uint8Array){pending.controller.enqueue(message.chunk);}
      else if(message.type==='end'){pending.controller?.close();pending.detach?.();requests.delete(message.id);}
      else if(message.type==='error'){pending.reject(Error(message.message));try{pending.controller?.error(Error(message.message));}catch{}pending.detach?.();requests.delete(message.id);}
    }
    function relayFetch(value,init={}){
      if(closed||popup.closed)return Promise.reject(Error('本机连接窗口已关闭'));
      const url=new URL(value);if(url.origin!==descriptor.endpoint||url.search||url.hash||!url.pathname.startsWith('/v1/')||url.pathname.startsWith('/v1/local/'))return Promise.reject(Error('Relay target rejected'));
      if(init.signal?.aborted)return Promise.reject(new DOMException('Aborted','AbortError'));
      const id=String(++sequence);
      return new Promise((resolve,reject)=>{
        const pending={resolve,reject};requests.set(id,pending);
        const abort=()=>{send({type:'abort',id});reject(new DOMException('Aborted','AbortError'));try{pending.controller?.error(new DOMException('Aborted','AbortError'));}catch{}pending.detach();requests.delete(id);};
        pending.detach=()=>init.signal?.removeEventListener('abort',abort);init.signal?.addEventListener('abort',abort,{once:true});
        send({type:'request',id,path:url.pathname,method:init.method||'GET',body:init.body});
      });
    }
    addEventListener('message',onMessage);addEventListener('storage',onStorage);addEventListener('pagehide',onPageHide);
    try{
      if(signal?.aborted){abort();return result;}signal?.addEventListener('abort',abort,{once:true});
      localStorage.setItem(key,JSON.stringify({created:Date.now(),ttl:Math.min(timeoutMs,1800000)}));
      channel=new BroadcastChannel('km-agent-connect-'+state);channel.onmessage=event=>receive(event.data);
      deadline=setTimeout(()=>{cleanup('连接超时。请确认已安装连接器，并在同一浏览器配置中重新接入。');popup.close();},timeoutMs);
      watch=setInterval(()=>{if(popup.closed)cleanup('本机连接窗口已关闭，请重新接入');},500);
      if(resume){
        if(!validDescriptor({...resume,state,ticket:random()},state))throw Error('后台连接地址无效');
        descriptor={...resume,state};erase();channel.close();onStatus('正在连接后台服务…');
        popup.location.href=descriptor.endpoint+'/connect#'+new URLSearchParams({state,origin,instanceId:descriptor.instanceId});return result;
      }
      onStatus('请在本机连接器中确认此次接入');
      if(launch)Promise.resolve(launch(url)).catch(()=>{cleanup('无法唤起本机连接器');popup.close();});else popup.location.href=url;
    }catch{cleanup('网页存储不可用，无法建立安全连接');popup.close();}
    return result;
  }
  globalThis.KmDesktopConnector=Object.freeze({connect,challengeFor:sha256,randomUUID});
})();
