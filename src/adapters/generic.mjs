/** Portable command adapter. Deliberately NOT a vendor's native conversation API. */
export function createGenericAdapter(sessionId){
 if(!/^ses[\w-]+$/.test(sessionId||''))throw Error('通用适配器需明确会话标识');
 const info={id:sessionId,title:'本地Agent · 通用发布通道'};
 return{descriptor:{id:'generic',status:'publish-only'},health:async()=>({ready:true,version:'km-agent/1',message:'通用本地发布已就绪；无原生双向聊天/工具订阅'}),listSessions:async()=>[info],bindSession:async id=>{if(id!==sessionId)throw Error('未授权的发布会话');return info;},readShared:async()=>({status:'idle',messages:[],tools:[]}),watch:(id,event,state)=>{queueMicrotask(()=>state('connected'));return{ready:Promise.resolve(),close(){}};}};
}
