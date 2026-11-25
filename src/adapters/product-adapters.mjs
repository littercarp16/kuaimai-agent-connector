import{createGenericAdapter}from'./generic.mjs';
import{createNativeRegistry}from'./native-registry.mjs';
import{createQwenWorkAdapter}from'./qwenwork.mjs';
export function createProductAdapters({adapter='generic',sessionId,workspace,codexWorkspace=workspace,codexSessionScope='workspace',codexEnabled=true,qwenEnabled=false,qwenSessionId,workBuddyServe},{codex,generic=createGenericAdapter}={}){
 if(adapter!=='generic')throw Error('不支持此适配器，请在网页选择 Codex、千问办公或 WorkBuddy CLI');
 if(typeof codexEnabled!=='boolean'||codexEnabled&&typeof codex!=='function')throw Error('需要明确的产品原生适配器工厂');
 const primary=sessionId?generic(sessionId):{descriptor:{id:'generic',status:'publish-only'},health:async()=>({ready:true,version:'km-agent/1',message:'仅协作发布入口，尚未选择任务；无原生控制'}),listSessions:async()=>[]};
 const additional=codexEnabled?[codex({directory:codexWorkspace,...(codexSessionScope==='agent'?{sessionScope:'agent'}:{})})]:[];
 if(qwenEnabled||qwenSessionId)additional.push(createQwenWorkAdapter({sessionId:qwenSessionId}));
 if(workBuddyServe)additional.push(workBuddyServe);
 return createNativeRegistry({primary,additional});
}
