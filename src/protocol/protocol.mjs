export const PROTOCOL='km-agent/1';
export const COMMANDS=Object.freeze({
 'resource.create':{group:'navigation',payload:'{id,kind:page|table|dashboard|task,name,appearance?}',effect:'创建未保存预览，呼出工作区并进入编辑'},
 'resource.open':{group:'navigation',payload:'{artifactId}',effect:'呼出并查看已有成果'},
 'resource.edit':{group:'navigation',payload:'{artifactId}',effect:'进入已有成果的生成/编辑视图，不写平台'},
 'panel.open':{group:'navigation',payload:'{mode:side|workspace}',effect:'呼出非模态协作界面'},
 'panel.close':{group:'navigation',payload:'{}',effect:'收起界面，不中断Agent'},
 'work.status':{group:'feedback',payload:'{artifactId,status:running|waiting|completed|failed,label}',effect:'真实等待/构建/失败反馈，不模拟百分比'},
 'activity.updated':{group:'timeline',payload:'{id,kind:phase|skill|tool|thinking|permission,label,status:running|waiting|completed|failed,detail?}',effect:'公开活动卡；thinking只允许状态标签，公开摘要使用phase'},
 'plan.updated':{group:'artifact',payload:'{title,items:[{id,kind,name}]}',effect:'更新计划'},
 'step.updated':{group:'timeline',payload:'{id,label,status,detail?}',effect:'公开阶段步骤'},
 'artifact.updated':{group:'artifact',payload:'{id,kind,name,appearance?,document?,interactions?,metrics?,chart?,sections?,columns?,rows?,code?}',effect:'更新局部/完整预览，默认构建中'},
 'page.section.updated':{group:'artifact',payload:'{artifactId,section:{id,title,text}}',effect:'按键更新区块'},
 'table.rows.append':{group:'artifact',payload:'{artifactId,rows}',effect:'受限预览追加行'},
 'artifact.focus':{group:'artifact',payload:'{artifactId}',effect:'跟随模式聚焦，不强制导航'},
 'artifact.ready':{group:'artifact',payload:'{artifactId}',effect:'预览组件就绪，不是平台保存'},
 'run.note':{group:'timeline',payload:'{text}',effect:'公开说明文字'}
});
export const ADAPTERS=Object.freeze([
  {id:'opencode',status:'native',receiveMessages:true,sendPrompt:true,nativeActivities:true,publishUI:true},
  {id:'workbuddy',status:'publish-only',receiveMessages:false,sendPrompt:false,nativeActivities:false,publishUI:true},
 {id:'generic',status:'publish-only',receiveMessages:false,sendPrompt:false,nativeActivities:false,publishUI:true,clients:['Codex','Claude Code','WorkBuddy','Qwen办公','其他能执行本机Node命令的Agent']}
]);
export const contract=()=>({protocol:PROTOCOL,commands:COMMANDS,adapters:ADAPTERS,limits:{eventBytes:19000},receipt:{accepted:'连接器数据投影已接收',applied:'浏览器已导航/渲染；非平台保存',deferred:'浏览器因阅读保护或访客模式延迟',failed:'目标或渲染失败'}});
