import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { createWorkBuddyClient, agentProtocol, INPUT_SCHEMAS, publicError, WorkBuddyError } from './workbuddy-client.mjs';

// Standard Schema adapter preserves full advertised JSON Schema but reduces validation
// failures to a constant: SDK errors must not echo arbitrary input values or field names.
function privateSchema(schema) {
  return { '~standard': {
    version: 1, vendor: 'km-workbuddy',
    validate(value) {
      const result = schema.safeParse(value);
      return result.success ? { value: result.data } : { issues: [{ message: 'INVALID_INPUT' }] };
    },
    jsonSchema: { input: () => z.toJSONSchema(schema, { io: 'input' }), output: () => z.toJSONSchema(schema) }
  } };
}
const descriptions = {
  km_task_open: '创建WorkBuddy公开协作任务。同一进程taskKey+title幂等，不能恢复其他进程ticket；不是原生session镜像。',
  km_task_publish: '向当前进程任务发布15类白名单UI预览事件。activity只允许公开phase。accepted不表示已展示或保存。',
  km_task_receipt: '查询当前进程任务内单个事件的浏览器回执；applied不表示用户阅读或平台保存。',
  km_task_finish: '确认任务completed或failed后停止本客户端心跳；不停止WorkBuddy，也不自动重发结束请求。',
  km_agent_protocol: '读取公开事件目录、限制与能力边界。无原生工具自动订阅、permission、私有推理或Questions控制。'
};

// The official SDK owns framing, negotiation and dispatch. At its transport
// boundary only error diagnostics are reduced, since e.g. an unknown tool name
// is untrusted input and may itself contain a credential.
class RedactedStdioTransport extends StdioServerTransport {
  send(message) {
    if (message.error) return super.send({ ...message, error: { code: message.error.code, message: 'MCP request rejected (diagnostic hidden).' } });
    return super.send(message);
  }
}
export function createWorkBuddyMcpServer(client) {
  const server = new McpServer({ name: 'kuaimai-workbuddy', version: '0.1.0' }, { maxToolInputElements: 10000 });
  const handlers = {
    km_task_open: args => client.open(args), km_task_publish: args => client.publish(args),
    km_task_receipt: args => client.receipt(args), km_task_finish: args => client.finish(args),
    km_agent_protocol: () => agentProtocol()
  };
  for (const [name, schema] of Object.entries(INPUT_SCHEMAS)) {
    server.registerTool(name, {
      description: descriptions[name], inputSchema: privateSchema(schema),
      annotations: { readOnlyHint: ['km_agent_protocol', 'km_task_receipt'].includes(name), destructiveHint: false, openWorldHint: false, idempotentHint: name !== 'km_task_publish' }
    }, async args => {
      try {
        const result = await handlers[name](args);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        const result = { error: publicError(error) };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      }
    });
  }
  return server;
}

export async function runStdio(args = process.argv.slice(2)) {
  if (Number(process.versions.node.split('.')[0]) < 22 || args.length !== 2 || args[0] !== '--config') throw new WorkBuddyError('INVALID_CONFIG');
  const client = await createWorkBuddyClient({ connectionFile: args[1] });
  const transport = new RedactedStdioTransport(process.stdin, process.stdout, { maxBufferSize: 256 * 1024 });
  const handle = serveStdio(() => createWorkBuddyMcpServer(client), {
    transport, onerror: () => process.stderr.write('WorkBuddy MCP: 协议或传输错误（详情已隐藏）。\n')
  });
  const cleanup = () => client.close();
  process.stdin.once('end', cleanup);
  process.once('exit', cleanup);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    cleanup();
    void handle.close().catch(() => {}).finally(() => { process.exitCode = 0; });
  });
  return handle;
}

