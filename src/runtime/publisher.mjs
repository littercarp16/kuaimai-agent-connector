import{readFile,stat}from'node:fs/promises';import{fileURLToPath}from'node:url';
export const RUNTIME=fileURLToPath(new URL('../../.runtime/connector.json',import.meta.url));
export async function readRuntime(path=RUNTIME){
 const info=await stat(path);if(!info.isFile()||(info.mode&0o077)!==0||(process.getuid&&info.uid!==process.getuid()))throw Error('运行凭据文件权限必须是当前用户0600');
 if(info.size>12000)throw Error('运行状态文件过大');const value=JSON.parse(await readFile(path,'utf8'));
 const url=new URL(value.endpoint);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.origin!==value.endpoint||url.username||url.password)throw Error('只允许固定loopback连接器端点');
 if(typeof value.key!=='string'||value.key.length<20)throw Error('本地发布授权无效');return value;
}
export async function publishEvent({runtimePath=RUNTIME,sessionId,event}){
 const runtime=await readRuntime(runtimePath);if(!sessionId){if(runtime.bindings?.length!==1)throw Error('请明确指定前端已绑定的会话ID');sessionId=runtime.bindings[0].id;}
 if(event?.protocol&&event.protocol!==runtime.protocol)throw Error('连接器运行协议不匹配，请先换版启动，不能静默丢弃新指令语义');
 if(typeof sessionId!=='string'||!/^ses[A-Za-z0-9_-]{1,120}$/.test(sessionId))throw Error('会话ID无效');
 const body=JSON.stringify({sessionId,event});if(Buffer.byteLength(body)>19000)throw Error('请把成果拆为小于19KB的独立UI事件');
 const response=await fetch(runtime.endpoint+'/v1/local/publish',{method:'POST',headers:{'Content-Type':'application/json','X-Km-Agent':'1','X-Km-Publisher':runtime.key},body,signal:AbortSignal.timeout(5000)});
 const result=await response.json();if(!response.ok||!result.ok)throw Error(result.error?.message||'本地发布未确认');return{ok:true,sessionId,eventId:event?.id,accepted:result.data.accepted??true,delivery:result.data.delivery||'accepted',projectionChanged:result.data.applied};
}
