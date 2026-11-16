import { test } from 'node:test';
import assert from 'node:assert/strict';
import{spawnSync}from'node:child_process';
import { detailPolicy, makeToolDetail } from '../../../src/tools/tool-details.mjs';

const api = await import('../../../src/adapters/codex/codex-native-tool-details.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const directory = '/workspace/project';
const mcp = overrides => ({ type: 'mcpToolCall', id: 'mcp-1', server: 'documents', tool: 'search',
  status: 'completed', arguments: { query: '公开说明' }, result: { content: [{ type: 'text', text: '公开结果' }] },
  error: null, durationMs: 12, ...overrides });
const map = item => {
  assert.equal(typeof api.nativeExternalTool, 'function');
  return api.nativeExternalTool(item, directory);
};
const hidden = (value, pattern) => assert.doesNotMatch(JSON.stringify(value), pattern);
const blocked = item => {
  const tool = map(item);
  assert.equal(tool.policy.blocked, true);
  assert.equal(tool.detail.request.available, false);
  assert.equal(tool.detail.result.available, false);
  hidden(tool, /DO_NOT_PUBLISH_BODY/);
  assert.match(tool.policy.reason, /保护|凭据|命令|上限|预算|未知|深|安全/);
  return tool;
};

test('genuine MCP exposes arguments, server/tool, text and structuredContent only in detail', () => {
  const item = mcp({ result: { content: [{ type: 'text', text: '共找到三条公开记录' }],
    structuredContent: { rows: [{ id: 'document-1', title: '需求' }], total: 3 } } });
  const before = structuredClone(item), tool = map(item);
  assert.equal(tool.name, 'mcp');
  assert.equal(tool.status, 'completed');
  assert.deepEqual(tool.content, []);
  assert.deepEqual(tool.policy, { blocked: false, reason: '' });
  assert.equal(tool.detail.toolId, item.id);
  assert.match(tool.detail.toolName, /documents.*search/);
  const request = JSON.parse(tool.detail.request.text);
  assert.equal(request.server, 'documents');
  assert.equal(request.tool, 'search');
  assert.deepEqual(request.arguments, item.arguments);
  assert.match(tool.detail.result.text, /共找到三条公开记录/);
  assert.match(tool.detail.result.text, /"total": 3/);
  assert.equal(tool.detail.request.format, 'json');
  assert.equal(tool.detail.result.available, true);
  assert.equal(tool.detail.result.redacted, false);
  assert.match(tool.publicInfo.summary, /documents.*search/);
  hidden(tool.publicInfo, /公开说明|共找到三条|document-1/);
  assert.deepEqual(item, before);
});
test('普通业务analysis与metadata字段不是内部推理或MCP私有_meta',()=>{const text='{ "analysis":"公开销售分析结论", "metadata":{"sku":"SKU-1"}, "id":9007199254740993 }',tool=map(mcp({arguments:{query:'public',analysis:'公开筛选说明',metadata:{view:'public'}},result:{content:[{type:'text',text}],structuredContent:{analysis:{summary:'公开业务结论'},metadata:{total:2,token:'META_SECRET'},productMetadata:{sku:'SKU-1'}},_meta:{hidden:'MCP_PRIVATE_META'}}}));assert.match(tool.detail.request.text,/公开筛选说明|public/);assert.match(tool.detail.result.text,/公开销售分析结论/);assert.match(tool.detail.result.text,/公开业务结论/);assert.match(tool.detail.result.text,/productMetadata/);assert.match(tool.detail.result.text,/SKU-1|9007199254740993/);hidden(tool,/META_SECRET|MCP_PRIVATE_META/);});

test('30K public output is complete, with accurate character count', () => {
  const text = '普通正文'.repeat(7500), tool = map(mcp({ result: { content: [{ type: 'text', text }] } }));
  assert.equal(tool.detail.result.text, text);
  assert.equal(tool.detail.result.totalChars, text.length);
  assert.equal(tool.detail.result.truncated, false);
  assert.equal(tool.detail.result.reason, '');
});
test('超长JSON字段名有独立预算，不能触发脱敏正则退化',()=>{const code=`import{nativeExternalTool,nativeTextPreview}from${JSON.stringify(new URL('../../../src/adapters/codex/codex-native-tool-details.mjs',import.meta.url).href)};const text=JSON.stringify({['A'.repeat(120000)]:'value'}),tool=nativeExternalTool({type:'mcpToolCall',id:'long-key',server:'public',tool:'query',arguments:{},status:'completed',result:{content:[{type:'text',text}]},error:null},'/workspace/project');console.log(JSON.stringify({mcp:tool.detail.result.available,native:nativeTextPreview(text).available}));`;const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:2000});assert.equal(child.error?.code,undefined,'超长字段名必须有界拒绝，不应卡住');assert.equal(child.status,0);assert.deepEqual(JSON.parse(child.stdout),{mcp:false,native:false});});

test('JSON text numbers, whitespace and credential-free URLs stay byte-for-byte intact', () => {
  const text = '{ "id":9007199254740993, "url":"https://example.com/a%2fb?q=a+b&x=2#section", "ok":true }\n';
  const tool = map(mcp({ arguments: text, result: { content: [{ type: 'text', text }], structuredContent: text } }));
  assert.equal(JSON.parse(tool.detail.request.text).arguments, text);
  assert.ok(tool.detail.result.text.includes(text));
  assert.match(tool.detail.result.text, /9007199254740993/);
  assert.doesNotMatch(tool.detail.result.text, /9007199254740992/);
  assert.equal(tool.detail.result.redacted, false);
  const onlyText = map(mcp({ result: { content: [{ type: 'text', text }] } }));
  assert.equal(onlyText.detail.result.text, text);
});

test('nested secrets, bare credentials, private analysis fields and tags are redacted', () => {
  const tool = map(mcp({ arguments: { query: '公开搜索', nested: { access_token: 'ARG_SECRET',
    private_analysis: { text: 'ARG_PRIVATE' } } }, result: {
    content: [{ type: 'text', text: '{"visible":"yes","nested":{"token":"RESULT_SECRET"},"private_analysis":{"steps":["PRIVATE_ANALYSIS"]},"reasoning":"PRIVATE_REASONING"}\n<analysis>PRIVATE_TAG</analysis>\nsk-BARECREDENTIAL12345678\nhttps://alice:URL_PASSWORD@example.com/a?token=URL_TOKEN' }],
    structuredContent: { visible: 1, auth: { password: 'STRUCTURED_PASSWORD' }, private_analysis: 'STRUCTURED_PRIVATE' },
  } }));
  assert.equal(tool.policy.blocked, false);
  assert.equal(tool.detail.request.available, true);
  assert.equal(tool.detail.request.redacted, true);
  assert.equal(tool.detail.result.available, true);
  assert.equal(tool.detail.result.redacted, true);
  assert.match(tool.detail.result.text, /visible/);
  hidden(tool, /ARG_SECRET|ARG_PRIVATE|RESULT_SECRET|PRIVATE_ANALYSIS|PRIVATE_REASONING|PRIVATE_TAG|BARECREDENTIAL|URL_PASSWORD|URL_TOKEN|STRUCTURED_PASSWORD|STRUCTURED_PRIVATE/);
});

test('private metadata and image/audio/blob payloads are omitted with explicit reasons', () => {
  const tool = map(mcp({ arguments: { query: 'public', _meta: { notes: 'ARG_METADATA' } }, result: {
    _meta: { harmlessLookingField: 'ROOT_METADATA' },
    content: [
      { type: 'text', text: 'visible', _meta: { unknown: 'TEXT_METADATA' } },
      { type: 'image', mimeType: 'image/png', data: 'IMAGE_BASE64' },
      { type: 'audio', data: 'AUDIO_BASE64' },
      { type: 'resource', resource: { uri: 'file:///public/image', blob: 'BLOB_BASE64' } },
      { type: 'unrecognized', text: 'UNKNOWN_CONTENT' },
    ],
    structuredContent: { data: 'ordinary data survives', nested: { _meta: { unknown: 'NESTED_METADATA' },
      private_metadata: { other: 'OTHER_METADATA' }, blob: 'STRUCTURED_BLOB', base64: 'STRUCTURED_BASE64' } },
    unknownMetadata: { text: 'UNKNOWN_RESULT_FIELD' },
  } }));
  assert.equal(tool.detail.result.available, true);
  assert.match(tool.detail.result.text, /visible|ordinary data survives/);
  assert.match(tool.detail.result.reason, /元信息|metadata/);
  assert.match(tool.detail.result.reason, /非文本|二进制/);
  assert.match(tool.detail.result.reason, /未知|不支持/);
  assert.equal(tool.detail.result.redacted, true);
  hidden(tool, /ARG_METADATA|ROOT_METADATA|TEXT_METADATA|IMAGE_BASE64|AUDIO_BASE64|BLOB_BASE64|UNKNOWN_CONTENT|NESTED_METADATA|OTHER_METADATA|STRUCTURED_BLOB|STRUCTURED_BASE64|UNKNOWN_RESULT_FIELD/);
});

test('JSON-text metadata and binary fields are not exposed through a string wrapper', () => {
  const text = '{"id":9007199254740993,"_meta":{"unknown":"TEXT_META"},"blob":"TEXT_BLOB","private_analysis":"TEXT_ANALYSIS","visible":"ok"}';
  const tool = map(mcp({ result: { content: [{ type: 'text', text }] } }));
  assert.equal(tool.detail.result.available, true);
  assert.match(tool.detail.result.text, /9007199254740993|visible/);
  assert.match(tool.detail.result.reason, /元信息/);
  hidden(tool, /TEXT_META|TEXT_BLOB|TEXT_ANALYSIS/);
});

test('failed MCP retains safe error.message and public text, not unknown error fields', () => {
  const tool = map(mcp({ status: 'failed', error: { message: '上游返回 429；token=ERROR_SECRET',
    stack: 'ERROR_STACK', _meta: { value: 'ERROR_METADATA' } },
  result: { content: [{ type: 'text', text: '请稍后重试' }] } }));
  assert.equal(tool.status, 'failed');
  assert.equal(tool.detail.status, 'failed');
  assert.equal(tool.detail.result.available, true);
  assert.match(tool.detail.result.text, /429|请稍后重试/);
  assert.match(tool.error, /429/);
  hidden(tool, /ERROR_SECRET|ERROR_STACK|ERROR_METADATA/);
  hidden(tool.publicInfo, /429|请稍后重试/);
});

test('running, unknown status, returned no text, and returned only binary are distinct', () => {
  const pending = map(mcp({ status: 'inProgress', result: null }));
  assert.equal(pending.status, 'running');
  assert.equal(pending.detail.result.available, false);
  assert.match(pending.detail.result.reason, /尚未返回/);
  const unknown = map(mcp({ status: 'futureStatus' }));
  assert.equal(unknown.status, 'running');
  assert.equal(unknown.detail.result.available, false);
  assert.match(unknown.detail.result.reason, /未知/);
  const empty = map(mcp({ result: { content: [] } }));
  assert.equal(empty.status, 'completed');
  assert.equal(empty.detail.result.available, false);
  assert.match(empty.detail.result.reason, /未提供.*文本/);
  const binary = map(mcp({ result: { content: [{ type: 'image', data: 'UNSHOWN_BINARY' }] } }));
  assert.equal(binary.detail.result.available, false);
  assert.match(binary.detail.result.reason, /非文本/);
  hidden(binary, /UNSHOWN_BINARY/);
});

test('nested explicit targets and file URIs to protected resources block the entire item', () => {
  const inputs = [
    { path: '.env' }, { nested: { filePath: '/home/example/.codex/auth.json' } },
    { files: ['normal.txt', '/home/example/.config/opencode/config.json'] },
    { nested: { cwd: '/workspace/.runtime', path: 'connector.json' } },
    { options: { directory: '/home/example/.claude' } },
    { options: { file_uri: 'file:///workspace/%2eenv' } },
    { path: 'file:///home/example/.codex/auth.json' },
    { resource: 'file:///home/example/.codex/auth.json' },
    { filePath: '/Users/example/Library/Keychains/login.keychain-db' },
    '{"nested":{"path":"/workspace/.env"}}',
  ];
  for (const arguments_ of inputs) blocked(mcp({ arguments: arguments_,
    result: { content: [{ type: 'text', text: 'DO_NOT_PUBLISH_BODY' }] } }));
});

test('explicit shell command arguments use shell protection, even for an unknown MCP server', () => {
  for (const arguments_ of [{ command: 'cat .env' }, { nested: { cmd: 'security find-generic-password -w' } },
    { command: 'printenv' }, { command: ['cat', '/home/example/.codex/auth.json'] },
    { command: 'echo ' + 'x'.repeat(9000) + '; cat .env' }]) {
    blocked(mcp({ server: 'unknown-server', tool: 'not-shell', arguments: arguments_,
      result: { content: [{ type: 'text', text: 'DO_NOT_PUBLISH_BODY' }] } }));
  }
});

test('ordinary query/text documentation examples are not misclassified as real file targets', () => {
  const tool = map(mcp({ tool: 'read', arguments: {
    query: '文档示例 cat .env 和 /home/example/.codex/auth.json 并非实际文件读取',
    text: '{"path":"/workspace/.env"}', examples: ['.env', 'security find-generic-password'],
  } }));
  assert.equal(tool.name, 'mcp');
  assert.equal(tool.policy.blocked, false);
  assert.equal(tool.detail.result.text, '公开结果');
  assert.match(tool.detail.request.text, /文档示例/);
});

test('protected results can be redacted while public results stay visible', () => {
  const tool = map(mcp({ result: { content: [{ type: 'text', text: '{"key":"CREDENTIAL_VALUE","public":"normal"}' }] } }));
  assert.equal(tool.policy.blocked, false);
  assert.equal(tool.detail.result.available, true);
  assert.equal(tool.detail.result.redacted, true);
  assert.match(tool.detail.result.text, /normal/);
  hidden(tool, /CREDENTIAL_VALUE/);
});

test('deep and oversized arguments fail closed, without publishing their result', () => {
  let deep = { path: '.env' };
  for (let i = 0; i < 80; i++) deep = { nested: deep };
  for (const arguments_ of [deep, { query: 'x'.repeat(512001) }, { list: Array.from({ length: 12000 }, () => ({ q: 1 })) }]) {
    blocked(mcp({ arguments: arguments_, result: { content: [{ type: 'text', text: 'DO_NOT_PUBLISH_BODY' }] } }));
  }
});

test('result byte, node and depth budgets have explicit non-success reasons', () => {
  let deep = { visible: true };
  for (let i = 0; i < 80; i++) deep = { nested: deep };
  for (const result of [
    { content: [{ type: 'text', text: 'x'.repeat(512001) }] },
    { content: [{ type: 'text', text: '中'.repeat(180000) }] },
    { content: [], structuredContent: deep },
    { content: [], structuredContent: Array.from({ length: 12000 }, () => ({ visible: true })) },
  ]) {
    const tool = map(mcp({ result }));
    assert.equal(tool.status, 'completed');
    assert.equal(tool.detail.result.available, false);
    assert.equal(tool.detail.result.truncated, false);
    assert.match(tool.detail.result.reason, /上限|预算|过深/);
  }
});

test('huge private metadata is omitted without consuming the public text budget', () => {
  const tool = map(mcp({ result: { content: [{ type: 'text', text: 'visible' }],
    _meta: { privatePayload: 'HUGE_METADATA'.repeat(60000) } } }));
  assert.equal(tool.detail.result.available, true);
  assert.equal(tool.detail.result.text, 'visible');
  assert.match(tool.detail.result.reason, /元信息/);
  hidden(tool, /HUGE_METADATA/);
});

test('dynamic tools extract only 0.166 inputText, not alternate guessed output fields', () => {
  const tool = map({ type: 'dynamicToolCall', id: 'dynamic-1', namespace: 'public-api', tool: 'shell',
    arguments: { topic: 'request' }, status: 'completed', success: true,
    contentItems: [{ type: 'inputText', text: 'dynamic public result' },
      { type: 'inputImage', imageUrl: 'data:image/png;base64,DYNAMIC_IMAGE' },
      { type: 'inputAudio', audioUrl: 'DYNAMIC_AUDIO' }, { type: 'text', text: 'WRONG_DYNAMIC_KIND' }],
    result: 'GUESSED_DYNAMIC_RESULT', output: 'GUESSED_DYNAMIC_OUTPUT' });
  assert.equal(tool.name, 'native-tool');
  assert.equal(tool.status, 'completed');
  assert.equal(tool.policy.blocked, false);
  assert.equal(tool.detail.result.text, 'dynamic public result');
  assert.match(tool.publicInfo.summary, /public-api.*shell/);
  assert.match(tool.detail.result.reason, /非文本/);
  hidden(tool, /DYNAMIC_IMAGE|DYNAMIC_AUDIO|WRONG_DYNAMIC_KIND|GUESSED_DYNAMIC/);
  const failed = map({ type: 'dynamicToolCall', id: 'dynamic-2', tool: 'read', arguments: {},
    status: 'completed', success: false, contentItems: [{ type: 'inputText', text: 'public failure' }] });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.detail.result.text, 'public failure');
});

test('function output supports strings and 0.166 input_text with no fabricated request', () => {
  const raw = '{"id":9007199254740993,"url":"https://example.com/?n=1#x"}';
  const tool = map({ type: 'functionCallOutput', id: 'output-1', name: 'skill', namespace: 'public-api', output: raw });
  assert.equal(tool.name, 'native-tool');
  assert.equal(tool.status, 'completed');
  assert.equal(tool.detail.request.available, false);
  assert.match(tool.detail.request.reason, /未提供|不包含/);
  assert.equal(tool.detail.result.text, raw);
  const array = map({ type: 'functionCallOutput', id: 'output-2', name: 'read', output: [
    { type: 'input_text', text: 'first' }, { type: 'input_text', text: 'second' },
    { type: 'input_image', image_url: 'FUNCTION_IMAGE' }, { type: 'input_audio', audio_url: 'FUNCTION_AUDIO' },
    { type: 'encrypted_content', encrypted_content: 'FUNCTION_ENCRYPTED' },
    { type: 'inputText', text: 'WRONG_FUNCTION_KIND' },
  ] });
  assert.equal(array.detail.result.text, 'first\nsecond');
  assert.match(array.detail.result.reason, /非文本/);
  hidden(array, /FUNCTION_IMAGE|FUNCTION_AUDIO|FUNCTION_ENCRYPTED|WRONG_FUNCTION_KIND/);
});

test('arbitrary kinds and name suffixes never impersonate genuine native provenance', () => {
  for (const item of [null, {}, { type: 'mcp', name: 'mcpToolCall' },
    { type: 'shell', name: 'mcpToolCall' }, { type: 'custom.read', name: 'read' },
    { type: 'McpToolCall', name: 'shell' }, { type: 'agentMessage', name: 'functionCallOutput' }]) {
    assert.equal(map(item), null);
  }
  assert.equal(detailPolicy('mcp', {}).blocked, true);
  assert.equal(detailPolicy('native-tool', {}).blocked, true);
  for (const name of ['custom.read', 'custom.shell', 'custom.skill', 'mcp']) {
    const legacy = makeToolDetail({ toolId: 'legacy', name, input: { path: 'public.txt' },
      content: [{ type: 'text', text: 'LEGACY_UNKNOWN_RESULT' }], status: 'completed' });
    assert.equal(legacy.result.available, false);
    hidden(legacy, /LEGACY_UNKNOWN_RESULT/);
  }
});

test('cyclic input is rejected by the bounded pure helper rather than throwing', () => {
  const arguments_ = {};
  arguments_.self = arguments_;
  blocked(mcp({ arguments: arguments_, result: { content: [{ type: 'text', text: 'DO_NOT_PUBLISH_BODY' }] } }));
});

test('safe error.message uses the same private-field boundary as result text', () => {
  const tool = map(mcp({ status: 'failed', error: { message: '{"message":"429","private_analysis":"ERROR_ANALYSIS","_meta":{"other":"ERROR_META"}}' }, result: null }));
  assert.match(tool.error, /429/);
  assert.match(tool.detail.result.text, /429/);
  hidden(tool, /ERROR_ANALYSIS|ERROR_META/);
});

test('inline binary data URIs are omitted even inside declared public text', () => {
  const tool = map(mcp({ result: { content: [{ type: 'text', text: '正常文本 data:image/png;base64,INLINE_IMAGE\nhttps://example.com/a' }],
    structuredContent: { text: 'data:audio/wav;base64,INLINE_AUDIO' } } }));
  assert.match(tool.detail.result.text, /正常文本|https:\/\/example.com\/a/);
  assert.match(tool.detail.result.reason, /非文本/);
  hidden(tool, /INLINE_IMAGE|INLINE_AUDIO/);
});

test('native labels also filter explicit private fields instead of leaking them in summaries', () => {
  const tool = map(mcp({ server: '{"private_analysis":"LABEL_PRIVATE","_meta":"LABEL_META"}' }));
  hidden(tool, /LABEL_PRIVATE|LABEL_META/);
  assert.match(tool.publicInfo.summary, /search/);
});

test('large JSON-string arguments are checked once, not double-counted as parsed output', () => {
  const arguments_ = '{"query":"' + 'x'.repeat(280000) + '","id":9007199254740993}';
  const tool = map(mcp({ arguments: arguments_ }));
  assert.equal(tool.policy.blocked, false);
  assert.equal(JSON.parse(tool.detail.request.text).arguments, arguments_);
});

test('target scanning does not stop at hidden argument metadata', () => {
  blocked(mcp({ arguments: { options: { _meta: { nested: { path: '.env' } } } },
    result: { content: [{ type: 'text', text: 'DO_NOT_PUBLISH_BODY' }] } }));
});

test('deep JSON text and excessive JSON text nodes have bounded unavailable results', () => {
  for (const text of ['{"nested":'.repeat(80) + 'true' + '}'.repeat(80),
    '[' + Array.from({ length: 12000 }, () => '1').join(',') + ']']) {
    const tool = map(mcp({ result: { content: [{ type: 'text', text }] } }));
    assert.equal(tool.detail.result.available, false);
    assert.match(tool.detail.result.reason, /深|预算|上限/);
  }
});

test('long-run filtering cannot restore a hidden secret via an escaped placeholder lookalike', () => {
  const secret = 'SECRET_LONG_VALUE_' + 'x'.repeat(1000);
  const text = '{"token":"' + secret + '","public":"\\uE000native0\\uE001 \\uE000native0:0\\uE001 \\uE000native1:0\\uE001 password=HIDE_ME"}';
  const tool = map(mcp({ result: { content: [{ type: 'text', text }] } }));
  assert.equal(tool.detail.result.available, true);
  hidden(tool, /SECRET_LONG_VALUE|HIDE_ME/);
});

test('long ordinary text and URLs are complete while long credential values stay hidden', () => {
  const text = 'x'.repeat(30000), url = 'https://example.com/' + 'p'.repeat(2000) + '?q=' + 'v'.repeat(500);
  const ordinary = map(mcp({ result: { content: [{ type: 'text', text: text + '\n' + url }] } }));
  assert.equal(ordinary.detail.result.text, text + '\n' + url);
  assert.equal(ordinary.detail.result.redacted, false);
  const secret = 'LARGE_CREDENTIAL_' + 'x'.repeat(3000);
  const sensitive = map(mcp({ result: { content: [{ type: 'text', text: '{"secret":"' + secret + '","url":"https://alice:' + secret + '@example.com/a?token=' + secret + '","public":"yes"}' }] } }));
  assert.match(sensitive.detail.result.text, /public|yes/);
  assert.equal(sensitive.detail.result.redacted, true);
  hidden(sensitive, /LARGE_CREDENTIAL/);
});

test('files objects do not turn their explanatory text into target paths', () => {
  const tool = map(mcp({ arguments: { files: [{ path: 'public.txt', text: '示例 /workspace/.env' }] } }));
  assert.equal(tool.policy.blocked, false);
  assert.equal(tool.detail.result.available, true);
});

test('dynamic targets retain the same safety boundary regardless of the tool name', () => {
  blocked({ type: 'dynamicToolCall', id: 'unsafe-dynamic', tool: 'skill', status: 'completed',
    arguments: { nested: { path: '/workspace/.env' } },
    contentItems: [{ type: 'inputText', text: 'DO_NOT_PUBLISH_BODY' }] });
});

test('escaped credential prefixes in long JSON strings still reach the shared filter', () => {
  const secret = 'ESCAPED_SECRET_' + 'x'.repeat(1000);
  for (const value of ['\\u0073k-' + secret,
    '\\u0068\\u0074\\u0074\\u0070\\u0073\\u003a\\u002f\\u002falice\\u003a' + secret + '@example.com/a']) {
    const tool = map(mcp({ result: { content: [{ type: 'text', text: '{"public":"' + value + '","visible":true}' }] } }));
    assert.equal(tool.detail.result.available, true);
    hidden(tool, /ESCAPED_SECRET/);
    assert.match(tool.detail.result.text, /visible/);
  }
});

test('HIGH1 normalization and nested JSON decoding cannot restore hidden credential runs', () => {
  const body = 'A'.repeat(300), variants = [
    'sk-\0' + body,
    's\x1b[31mk-\x1b[0m' + body,
    'ghp_\x7f' + body,
    'eyJ' + body + '.\0' + body + '.' + body,
    '{"public":"\\u0073k-' + body + '","visible":9007199254740993}',
    JSON.stringify({ wrapped: '{"public":"\\u0073k-' + body + '","visible":true}' }),
    JSON.stringify({ wrapped: '<private_reasoning>PRIVATE_NESTED</private_reasoning> sk-\0' + body }),
    JSON.stringify({ wrapped: '{"\\u0070rivate_analysis":"PRIVATE_NESTED","public":"sk-\\u0000' + body + '"}' }),
  ];
  for (const text of variants) {
    for (const detail of [api.nativeTextPreview(text), map(mcp({ result: { content: [{ type: 'text', text }] } })).detail.result]) {
      assert.equal(detail.available, true);
      assert.equal(detail.redacted, true);
      hidden(detail, /A{40}|PRIVATE_NESTED/);
    }
  }
  const ordinary = '{ "id":9007199254740993, "url":"https://example.com/a%2fb?q=a+b#ok", "text":"' + 'z'.repeat(30000) + '" }\n';
  assert.equal(api.nativeTextPreview(ordinary).text, ordinary);
});

test('HIGH2 canonical base aliases and inherited relative targets use one unambiguous directory', () => {
  for (const key of ['working_directory', 'workingDirectory', 'working-directory', 'WORKING_DIRECTORY', 'work_dir', 'cwd']) {
    blocked(mcp({ arguments: { [key]: '/workspace/.config', path: 'opencode/config.json' },
      result: { content: [{ type: 'text', text: 'DO_NOT_PUBLISH_BODY' }] } }));
  }
  blocked(mcp({ arguments: { working_directory: '/workspace/.config', nested: { working_directory: '.', files: ['opencode/config.json'] } },
    result: { content: [{ type: 'text', text: 'DO_NOT_PUBLISH_BODY' }] } }));
  const ambiguous = blocked(mcp({ arguments: { cwd: '/workspace/public', working_directory: '/workspace/.config', path: 'opencode/config.json' },
    result: { content: [{ type: 'text', text: 'DO_NOT_PUBLISH_BODY' }] } }));
  assert.match(ambiguous.policy.reason, /目录|别名|保护/);
  const same = map(mcp({ arguments: { cwd: '/workspace/public', work_dir: '/workspace/public/.', path: 'report.txt' } }));
  assert.equal(same.policy.blocked, false);
});

function deadlineCase(expression) {
  const code = `import{nativeExternalTool,nativeTextPreview}from${JSON.stringify(new URL('../../../src/adapters/codex/codex-native-tool-details.mjs', import.meta.url).href)};const text=${expression};const mcp=nativeExternalTool({type:'mcpToolCall',id:'budget',server:'public',tool:'query',arguments:{},status:'completed',result:{content:[{type:'text',text}]},error:null},'/workspace/project').detail.result,native=nativeTextPreview(text);console.log(JSON.stringify({mcp:{available:mcp.available,reason:mcp.reason,equal:mcp.text===text},native:{available:native.available,reason:native.reason,equal:native.text===text}}));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 2000 });
  assert.equal(child.error?.code, undefined, '同步过滤必须在独立进程2秒预算内结束');
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test('MED3 long JSON keys fail with a field-key budget under the child deadline', () => {
  const result = deadlineCase(`'{"'+'P'.repeat(100000)+'":1}'`);
  for (const detail of Object.values(result)) {
    assert.equal(detail.available, false);
    assert.match(detail.reason, /字段|预算|上限/);
  }
});

test('MED3 dotted text, malformed repetition and nested long ordinary values remain bounded', () => {
  for (const expression of [`'A'.repeat(200000)`, `'a.'.repeat(60000)`, `'not-json,'.repeat(15000)`,
    `JSON.stringify({nested:JSON.stringify({text:'a'.repeat(200000),id:'9007199254740993'})})`]) {
    const result = deadlineCase(expression);
    for (const detail of Object.values(result)) {
      assert.equal(detail.available, true);
      assert.equal(detail.equal, true);
    }
  }
  const result = deadlineCase(`'{"field":'.repeat(10000)`);
  for (const detail of Object.values(result)) assert.match(detail.reason, /深|预算|上限/);
});

test('MED4 typed binary arguments and JSON text omit bytes, but preserve public numeric text', () => {
  const data = 'BINARY_PAYLOAD_' + 'A'.repeat(300), payload = { type: 'image', mimeType: 'image/png', data };
  const tool = map(mcp({ arguments: { payload, visible: 'public argument' }, result: { content: [{ type: 'text',
    text: '{ "payload":' + JSON.stringify(payload) + ', "id":9007199254740993, "analysis":"business conclusion" }' }] } }));
  assert.equal(tool.policy.blocked, false);
  assert.equal(tool.detail.request.redacted, true);
  assert.equal(tool.detail.result.redacted, true);
  assert.match(tool.detail.request.reason, /非文本|二进制/);
  assert.match(tool.detail.result.reason, /非文本|二进制/);
  assert.match(tool.detail.request.text, /public argument/);
  assert.match(tool.detail.result.text, /9007199254740993|business conclusion/);
  hidden(tool, /BINARY_PAYLOAD|A{40}/);
  const wrapped = api.nativeTextPreview(JSON.stringify({ wrapped: JSON.stringify({ payload, visible: true }) }));
  assert.equal(wrapped.available, true);
  assert.match(wrapped.reason, /非文本|二进制/);
  hidden(wrapped, /BINARY_PAYLOAD|A{40}/);
});

test('MED4 protected targets inside hidden typed objects still block the entire item', () => {
  blocked(mcp({ arguments: { payload: { type: 'image', data: 'A'.repeat(300), _meta: { working_directory: '/workspace/.config', path: 'opencode/config.json' } } },
    result: { content: [{ type: 'text', text: 'DO_NOT_PUBLISH_BODY' }] } }));
});

test('MED4 public text prefixes and fences do not expose typed JSON binary payloads', () => {
  for (const type of ['image', 'audio', 'inputImage', 'input_audio', 'encrypted_content']) {
    const text = '公开结果\n```json\n{ "payload":{"type":' + JSON.stringify(type) +
      ',"data":"PREFIX_BINARY_' + 'A'.repeat(300) + '"}, "id":9007199254740993, "analysis":"public business" }\n```';
    for (const detail of [api.nativeTextPreview(text), map(mcp({ result: { content: [{ type: 'text', text }] } })).detail.result]) {
      assert.equal(detail.available, true);
      assert.equal(detail.redacted, true);
      assert.match(detail.reason, /非文本|二进制/);
      assert.match(detail.text, /9007199254740993|public business/);
      hidden(detail, /PREFIX_BINARY|A{40}/);
    }
  }
});

test('MED3 URL query traversal shares the node budget instead of repeated quadratic mutation', () => {
  const result = deadlineCase(`'https://example.com/?'+Array.from({length:10000},(_,i)=>'token'+i+'=VALUE').join('&')`);
  for (const detail of Object.values(result)) {
    assert.equal(detail.available, false);
    assert.match(detail.reason, /节点|预算|上限/);
  }
});

test('nativeTextPreview injection protects genuine shell/read/subagent detail bodies', () => {
  const text = '{ "id":9007199254740993, "public":"\\u0073k-' + 'A'.repeat(300) + '", "analysis":"business" }';
  for (const [name, input] of [['shell', { command: 'npm test' }], ['read', { path: 'report.txt' }], ['subagent', { description: 'public task' }]]) {
    const detail = makeToolDetail({ toolId: 'injected', name, input, content: [{ type: 'text', text }],
      status: 'completed', complete: true, previewer: api.nativeTextPreview });
    assert.equal(detail.result.available, true);
    assert.equal(detail.result.redacted, true);
    assert.match(detail.result.text, /9007199254740993|business/);
    hidden(detail, /A{40}/);
  }
});

test('MED3 bare JWT repeated prefixes without dots stay intact under the child deadline', () => {
  const result = deadlineCase(`'eyJ-'.repeat(50000)`);
  for (const detail of Object.values(result)) {
    assert.equal(detail.available, true);
    assert.equal(detail.equal, true);
  }
});

test('MED3 malformed JWT segment chains and noncredential sk/gh repetitions stay intact', () => {
  for (const expression of [`'eyJ-..'.repeat(30000)`, `'eyJ-.x..'.repeat(25000)`,
    `'sk.'.repeat(50000)`, `'ghp-'.repeat(50000)`]) {
    const result = deadlineCase(expression);
    for (const detail of Object.values(result)) {
      assert.equal(detail.available, true);
      assert.equal(detail.equal, true);
    }
  }
});

test('MED3 valid long JWT/sk/gh candidates are still masked within the child deadline', () => {
  for (const expression of [`'eyJ-'.repeat(45000)+'.PAYLOAD.SIGNATURE'`, `'sk-'.repeat(50000)`, `'ghp_'.repeat(50000)`]) {
    const code = `import{nativeExternalTool,nativeTextPreview}from${JSON.stringify(new URL('../../../src/adapters/codex/codex-native-tool-details.mjs', import.meta.url).href)};const text=${expression};const mcp=nativeExternalTool({type:'mcpToolCall',id:'credential',server:'public',tool:'query',arguments:{},status:'completed',result:{content:[{type:'text',text}]},error:null},'/workspace/project').detail.result,native=nativeTextPreview(text);console.log(JSON.stringify([mcp,native].map(d=>({available:d.available,redacted:d.redacted,masked:d.text.includes('[凭据已脱敏]'),length:d.text.length}))));`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 2000 });
    assert.equal(child.error?.code, undefined, '真实凭据形式也必须有界完成');
    assert.equal(child.status, 0, child.stderr);
    for (const detail of JSON.parse(child.stdout)) {
      assert.equal(detail.available, true);
      assert.equal(detail.redacted, true);
      assert.equal(detail.masked, true);
      assert.ok(detail.length < 100);
    }
  }
});

test('bare credential segment scanning honors boundaries and decoded/normalized prefixes', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SIGNATURE_A123';
  for (const text of [jwt, '-' + jwt, 'prefix-' + jwt + '-suffix', '公开 ' + jwt + ' end',
    'e\0yJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SIGNATURE_A123',
    JSON.stringify({ wrapped: '{"public":"\\u0065yJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SIGNATURE_A123","id":9007199254740993}' })]) {
    for (const detail of [api.nativeTextPreview(text), map(mcp({ result: { content: [{ type: 'text', text }] } })).detail.result]) {
      assert.equal(detail.available, true);
      assert.equal(detail.redacted, true);
      hidden(detail, /SIGNATURE_A123|eyJhbGciOiJIUzI1NiJ9/);
    }
  }
  for (const text of ['x_' + jwt, 'x' + jwt, 'eyJ.payload', 'eyJ-.payload.', 'eyJ-.payload.---']) {
    const detail = api.nativeTextPreview(text);
    assert.equal(detail.available, true);
    assert.equal(detail.text, text);
    assert.equal(detail.redacted, false);
  }
});
