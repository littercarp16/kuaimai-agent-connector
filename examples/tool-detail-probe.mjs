// Harmless local acceptance probe: no model, business API, credential read or file write.
console.log(JSON.stringify({probe:'KM_TOOL_DETAIL_PROBE',run:process.argv[2]||'default',notice:'本机只读验收样例，非订单业务数据',sampleRows:3,ok:true},null,2));
