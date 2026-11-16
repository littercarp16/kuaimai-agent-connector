import{homedir}from'node:os';
import{resolve,basename}from'node:path';
import{shellTokens}from'./tool-public.mjs';
import{redactText}from'./display-safety.mjs';
const MAX_RAW=128000,MAX_TEXT=12000,MAX_COMPLETE=512000;
const protectedPath=/(?:^|[/\\])(?:\.env(?:\.[\w.-]+)?|\.runtime|\.local-session|credentials?|id_rsa|id_ed25519)(?:[/\\]|$)|\.(?:pem|key)(?:$|\s|["'])/i;
const allowed=new Set(['shell','bash','read','glob','grep','patch','webfetch','websearch','skill','subagent','task']);
const fullTools=new Set(['skill','subagent','task']);
const typeOf=name=>String(name||'').toLowerCase();
export function protectedTarget(value,base='.'){
 const raw=String(value||'').replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/,homedir()).replace(/\\/g,'/'),path=resolve(base,raw).replace(/\\/g,'/'),name=basename(path).toLowerCase();
 return protectedPath.test(raw)||protectedPath.test(path)||['auth.json','credentials.json','opencode.json','opencode.jsonc','skill.md'].includes(name)||[raw,path].some(p=>/(?:^|\/)\.local\/share\/opencode(?:\/|$)|(?:^|\/)\.config\/opencode(?:\/|$)|(?:^|\/)\.(?:codex|claude)(?:\/|$)|(?:^|\/)\.(?:agents|opencode)\/skills(?:\/|$)/i.test(p));
}
const absent=reason=>({available:false,text:'',format:'text',redacted:false,truncated:false,totalChars:0,reason});
export function preview(value,{format='text',complete=false}={}){
 let raw;try{raw=typeof value==='string'?value:JSON.stringify(value,null,2);}catch{return absent('无法安全格式化此内容');}
  if(typeof raw!=='string'||!raw.length)return absent('工具未提供文本内容');if(Buffer.byteLength(raw)>(complete?MAX_COMPLETE:MAX_RAW))return absent(`内容超过${complete?'512KB完整详情':'128KB预览'}读取上限，未直接展示；请在本地查看原始结果`);
   let normalized=raw;try{normalized=JSON.stringify(JSON.parse(raw),null,2);}catch{}const text=redactText(raw,true,{complete}),truncated=!complete&&text.length>MAX_TEXT;return{available:true,text:truncated?text.slice(0,MAX_TEXT):text,format,redacted:text!==normalized,truncated,totalChars:text.length,reason:''};
}
export function detailPolicy(name,input){
 const tool=typeOf(name);if(!allowed.has(tool))return{blocked:true,reason:tool==='skill'?'技能正文不直接同步；技能标识和状态已展示':'该工具尚未开放原始结果展示'};
 if(!input||typeof input!=='object')return{blocked:true,reason:'缺少请求上下文，不能确认结果可公开展示'};
 const base=input.workdir||input.cwd||'.',targets=tool==='patch'?[...String(input.patchText||'').matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(x=>x[1]):[input.path||input.filePath||'',...(tool==='glob'?[input.pattern||'']:[])];
 if(protectedTarget(base)||targets.filter(Boolean).some(p=>protectedTarget(p,base)))return{blocked:true,reason:'受保护配置、凭据或技能资源，不同步正文'};
 if(['shell','bash'].includes(tool)){const command=String(input.command||input.cmd||'');if(shellTokens(command).filter(t=>!t.operator).some(t=>protectedTarget(t.value.replace(/^--?[\w-]+=/,''),base))||/security\s+find-|printenv|\bkeychain\b/i.test(command))return{blocked:true,reason:'命令涉及受保护配置、凭据或技能资源，请在本地查看'};}
 return{blocked:false,reason:''};
}
export function makeToolDetail({toolId,name,input,content,error,status='running',policy,previous,complete:full=false,previewer=preview}={}){
  const p=policy||detailPolicy(name,input),tool=typeOf(name),complete=full===true||fullTools.has(tool);let request=previous?.request;
  if(input!==undefined){if(p.blocked)request=absent(p.reason);else if(['shell','bash'].includes(tool)){const command=String(input.command||input.cmd||'').replace(/^(\s*(?:env\s+)?)(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)+/, '$1[环境赋值已隐藏] ');request=previewer(command,{format:'code',complete});}else request=previewer(input,{format:'json',complete});}
 request=request||absent('尚未收到请求参数');let result;
  if(p.blocked)result=absent(p.reason);else if(status==='running')result=absent('工具尚未返回结果');else{const texts=(Array.isArray(content)?content:[]).filter(c=>c?.type==='text'&&typeof c.text==='string').map(c=>c.text);if(error)texts.unshift(typeof error==='string'?error:JSON.stringify(error,null,2));result=previewer(texts.join('\n'),{complete});if(!result.available&&!texts.length)result.reason='工具已返回，但未提供可展示的文本结果';}
 return{toolId:String(toolId||''),toolName:String(name||'').slice(0,70),status:['completed','failed'].includes(status)?status:'running',request,result};
}
export function createDetailStore({maxEntries=64,maxBytes=2*1024*1024,ttl=30*60000,now=Date.now}={}){
 const entries=new Map();let bytes=0;const key=(session,id)=>session+':'+id;
 function remove(k){const e=entries.get(k);if(e){bytes-=e.bytes;entries.delete(k);}}
 return{put(session,id,data){const value=structuredClone(data),size=Buffer.byteLength(JSON.stringify(value)),k=key(session,id);remove(k);if(size>maxBytes)return;entries.set(k,{value,bytes:size,at:now()});bytes+=size;while(entries.size>maxEntries||bytes>maxBytes)remove(entries.keys().next().value);},get(session,id){const k=key(session,id),e=entries.get(k);if(!e)return null;if(now()-e.at>ttl){remove(k);return null;}return structuredClone(e.value);}};
}
