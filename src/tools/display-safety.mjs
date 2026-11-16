/* One text boundary for public summaries, question copy and authenticated detail views. */
export const secretKey=/(?:password|passwd|secret|token|authorization|cookie|api[-_]?key|private[-_]?key|credential|publish(?:er)?key|reasoning|chain_of_thought)|^key$/i;
function quotedEnd(text,start){const quote=text[start];for(let i=start+1;i<text.length;i++){if(text[i]==='\\'){i++;continue;}if(text[i]===quote)return i+1;}return text.length;}
function valueEnd(text,start){
 if(['"',"'"].includes(text[start]))return quotedEnd(text,start);
 if(!['{','['].includes(text[start])){let i=start;while(i<text.length&&!/[,;}\]\r\n]/.test(text[i]))i++;return i;}
 const stack=[];for(let i=start;i<text.length;i++){const c=text[i];if(['"',"'"].includes(c)){i=quotedEnd(text,i)-1;continue;}if(c==='{'||c==='[')stack.push(c);else if(c==='}'||c===']'){const open=stack.pop();if(open!==(c==='}'?'{':'['))return text.length;if(!stack.length)return i+1;}}return text.length;
}
const decodeLiteral=raw=>raw[0]==='"'?JSON.parse(raw):raw[0]==="'"?raw.slice(1,-1).replace(/\\(["'\\])/g,'$1').replace(/\\u([0-9a-f]{4})/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16))):raw;
function redactSensitiveFields(text){
 const fields=/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[\w-]+)\s*:\s*/g,chunks=[];let last=0,match;
 while((match=fields.exec(text))){let key;try{key=decodeLiteral(match[1]);}catch{continue;}if(!secretKey.test(key))continue;const start=fields.lastIndex,stop=valueEnd(text,start);chunks.push(text.slice(last,start),JSON.stringify(/reasoning|chain_of_thought/i.test(key)?'[内部推理内容不展示]':'[已脱敏]'));last=stop;fields.lastIndex=stop;}
 return chunks.length?chunks.join('')+text.slice(last):text;
}
// Inspect string tokens and sensitive value spans, never parse/reprint an entire
// public JSON object: numeric precision, whitespace and ordinary examples survive.
function redactJsonText(text,{complete,depth}){
 text=redactSensitiveFields(text);
 const chunks=[];let last=0;
 for(let i=0;i<text.length;){
  if(!['"',"'"].includes(text[i])){i++;continue;}
  const quote=text[i],end=quotedEnd(text,i),raw=text.slice(i,end);let decoded;
  try{decoded=decodeLiteral(raw);}catch{i=end;continue;}
  const filtered=redactText(decoded,false,{complete,depth:depth+1});
  if(filtered!==decoded){chunks.push(text.slice(last,i),quote==='"'?JSON.stringify(filtered):"'"+filtered.replace(/\\/g,'\\\\').replace(/'/g,"\\'")+"'");last=end;}
  i=end;
 }
 return chunks.length?chunks.join('')+text.slice(last):text;
}
function redactObject(value,depth=0,complete=false){if(depth>12)return'[结构过深，未展示]';if(Array.isArray(value))return value.map(x=>redactObject(x,depth+1,complete));if(value&&typeof value==='object'){const result={};for(const[k,v]of Object.entries(value))result[k]=secretKey.test(k)?'[已脱敏]':redactObject(v,depth+1,complete);return result;}return typeof value==='string'?redactText(value,false,{complete}):value;}
export function redactText(value,parseJSON=true,{complete=false,depth=0}={}){
 if(depth>12)return'[结构过深，未展示]';
 let text=String(value??'').replace(/\x1b\[[0-9;]*[A-Za-z]/g,'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'');
  if(parseJSON)try{return JSON.stringify(redactObject(JSON.parse(text),0,complete),null,2);}catch{}
  text=redactJsonText(text,{complete,depth});
 text=text.replace(/-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?(?:-----END [A-Z ]+-----|$)/g,'[密钥材料已隐藏]');
 text=text.replace(/<(private_reasoning|analysis|reasoning|chain_of_thought)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,'[内部推理内容不展示]');
 text=text.replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]+/g,raw=>{try{const u=new URL(raw);let changed=false;if(u.username||u.password){u.username='';u.password='';changed=true;}for(const key of u.searchParams.keys())if(secretKey.test(key)){u.searchParams.set(key,'[已脱敏]');changed=true;}if(!changed)return raw;u.hash='';return u.toString();}catch{return'[地址已隐藏]';}});
 text=text.replace(/(?:Authorization|Proxy-Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi,m=>m.split(':')[0]+': [已脱敏]');
 const key='[\\w-]*(?:password|passwd|secret|token|authorization|cookie|api[-_]?key|private[-_]?key|credential|publish(?:er)?key)[\\w-]*';
 const valuePattern='(?:"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|[^\\s,;}]+)';
 text=text.replace(new RegExp('(["\']?'+key+'["\']?\\s*[:=]\\s*)'+valuePattern,'gi'),'$1[已脱敏]');
 text=text.replace(complete?/(--(?:[\w-]*(?:token|password|secret|key)))(?:=|\s+)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;|&]+)/gi:/(--(?:[\w-]*(?:token|password|secret|key)|headers?|body|data|payload))(?:=|\s+)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;|&]+)/gi,'$1 [已脱敏]');
 return text.replace(/\bBearer\s+[^\s"',;}]+/gi,'Bearer [已脱敏]').replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,'[凭据已脱敏]');
}
