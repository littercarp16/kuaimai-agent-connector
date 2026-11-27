import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm, access, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { probeCodexProtocol, readCodexCapabilities, supportsAdditionalContext, supportsLocalImageInput } from '../../../src/adapters/codex/codex-protocol.mjs';
import { fixture, deferred } from '../../fixtures/codex-fixture.mjs';

const schema = () => ({ type: 'object', properties: {
  additionalContext: { type: ['object', 'null'], additionalProperties: { $ref: '#/definitions/Entry' } },
  input: { type: 'array', items: { $ref: '#/definitions/UserInput' } },
}, definitions: {
  Entry: { type: 'object', required: ['kind', 'value'], properties: {
    kind: { $ref: '#/definitions/Kind' }, value: { type: 'string' }, name: { type: ['string', 'null'] },
  } },
  Kind: { type: 'string', enum: ['untrusted', 'application'] },
  UserInput: { oneOf: [
    { type: 'object', required: ['type', 'text'], properties: { type: { type: 'string', enum: ['text'] }, text: { type: 'string' } } },
    { type: 'object', required: ['type', 'path'], properties: { type: { type: 'string', enum: ['localImage'] }, path: { type: 'string' } } },
  ] },
} });

test('capability detection validates the context and localImage shapes, not a release number', () => {
  assert.equal(supportsAdditionalContext(schema()), true);
  assert.equal(supportsLocalImageInput(schema()), true);
  const mutations = [
    s => delete s.properties.additionalContext,
    s => s.definitions.Kind.enum = ['untrusted'],
    s => s.definitions.Entry.properties.value.type = 'number',
    s => s.definitions.Entry.required.push('newRequiredField'),
    s => s.definitions.Kind = { $ref: 'https://example.invalid/schema' },
    s => s.definitions.Kind = { $ref: '#/definitions/Kind' },
  ];
  for (const mutate of mutations) { const s = schema(); mutate(s); assert.equal(supportsAdditionalContext(s), false); }
  const imageMutations = [
    s => delete s.properties.input,
    s => s.definitions.UserInput.oneOf = s.definitions.UserInput.oneOf.slice(0, 1),
    s => s.definitions.UserInput.oneOf[1].properties.path.type = 'number',
    s => s.definitions.UserInput.oneOf[1].required.push('extraRequired'),
  ];
  for (const mutate of imageMutations) { const s = schema(); mutate(s); assert.equal(supportsLocalImageInput(s), false); }
});

async function binaryFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'km-protocol-test-'));
  const binary = path.join(directory, 'codex');
  await writeFile(binary, 'fixture, never executed', { mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [], outputs = [];
  let version = '99.0.0-beta.1';
  const run = async (file, args, options) => {
    calls.push({ file, args, options });
    if (args[0] === '--version') return { stdout: 'codex-cli ' + version + '\n' };
    assert.deepEqual(args.slice(0, 4), ['app-server', 'generate-json-schema', '--experimental', '--out']);
    const output = args[4]; outputs.push(output); await mkdir(path.join(output, 'v2'));
    for (const name of ['TurnStartParams', 'TurnSteerParams']) await writeFile(path.join(output, 'v2', name + '.json'), JSON.stringify(schema()));
    return { stdout: '' };
  };
  return { directory, binary, run, calls, outputs, setVersion(value) { version = value; } };
}

test('uses the matching daemon binary, caches by binary identity and removes schema temp files', async t => {
  const f = await binaryFixture(t), discovery = { schemaBinary: f.binary, version: '99.0.0-beta.1' };
  assert.deepEqual(await readCodexCapabilities(discovery, { run: f.run }), { pageContext: true, attachments: true });
  assert.deepEqual(await readCodexCapabilities(discovery, { run: f.run }), { pageContext: true, attachments: true });
  assert.equal(f.calls.length, 2);
  await assert.rejects(access(f.outputs[0]));
  for (const call of f.calls) assert.equal(call.options.shell, false);
  await writeFile(f.binary, 'updated binary, same version');
  assert.equal((await readCodexCapabilities(discovery, { run: f.run })).pageContext, true);
  assert.equal(f.calls.length, 4);
});

test('missing schema, mismatched binary and unsafe executable only disable optional context', async t => {
  const f = await binaryFixture(t);
  assert.deepEqual(await readCodexCapabilities({}), { pageContext: false, attachments: false });
  assert.deepEqual(await readCodexCapabilities({ schemaBinary: f.binary, version: 'different' }, { run: f.run }), { pageContext: false, attachments: false });
  assert.equal(f.calls.length, 1);
  await chmod(f.binary, 0o722);
  assert.deepEqual(await readCodexCapabilities({ schemaBinary: f.binary, version: '99.0.0-beta.1' }, { run: f.run }), { pageContext: false, attachments: false });
  assert.equal(f.calls.length, 1);
  await chmod(f.binary, 0o700);
  const run = async (file, args, opts) => {
    const result = await f.run(file, args, opts);
    if (args[0] !== '--version') await rm(path.join(args[4], 'v2/TurnSteerParams.json'));
    return result;
  };
  assert.deepEqual(await readCodexCapabilities({ schemaBinary: f.binary, version: '99.0.0-beta.1' }, { run }), { pageContext: false, attachments: false });
  await assert.rejects(access(f.outputs[0]));
});

test('daemon binary alias moving during schema export cannot grant stale capabilities', async t => {
  const f = await binaryFixture(t), alias = path.join(f.directory, 'current');
  await symlink(f.binary, alias);
  const run = async (file, args, opts) => {
    const result = await f.run(file, args, opts);
    if (args[0] !== '--version') {
      const replacement = path.join(f.directory, 'replacement');
      await writeFile(replacement, 'replacement', { mode: 0o700 }); await rename(replacement, f.binary);
    }
    return result;
  };
  assert.deepEqual(await readCodexCapabilities({ schemaBinary: alias, version: '99.0.0-beta.1' }, { run }), { pageContext: false, attachments: false });
});

test('base probe is read-only; schema failure does not prevent basic connection', async () => {
  const calls = [], rpc = { request: async (...args) => { calls.push(args); return { data: [], nextCursor: null }; } };
  assert.deepEqual(await probeCodexProtocol(rpc, {}, { readCapabilities: async () => { throw Error('private failure'); } }), { pageContext: false, attachments: false });
  assert.deepEqual(calls, [['thread/list', { limit: 1, archived: false, useStateDbOnly: true }]]);
  for (const page of [null, [], {}, { data: {} }, { data: [], nextCursor: 42 }, { data: [{}, {}] }])
    await assert.rejects(probeCodexProtocol({ request: async () => page }, {}), { code: 'CODEX_PROTOCOL_INCOMPATIBLE' });
  for (const rpcCode of [-32601, -32602]) await assert.rejects(probeCodexProtocol({ request: async () => {
    throw Object.assign(Error('private'), { code: 'CODEX_RPC_ERROR', rpcCode });
  } }, {}), { code: 'CODEX_PROTOCOL_INCOMPATIBLE' });
});

test('adapter probes each connection once; protocol failure closes it and is clearly reported', async t => {
  let probes = 0;
  const f = await fixture(t, { version: '99.0.0', probe: async () => {
    probes++; throw Object.assign(Error('secret'), { code: 'CODEX_PROTOCOL_INCOMPATIBLE' });
  } });
  const health = await f.adapter.health();
  assert.equal(health.ready, false); assert.match(health.message, /协议不兼容/);
  assert.equal(f.rpc.closed, true); assert.equal(f.calls.length, 0); assert.equal(probes, 1);
  const g = await fixture(t, { version: 'nightly', probe: async rpc => { probes++; return probeCodexProtocol(rpc, {}); } });
  assert.equal((await g.adapter.health()).ready, true); g.advance(); await g.adapter.health();
  assert.equal(probes, 2); assert.equal(g.adapter.capabilities.pageContext, false);
});

test('adapter closed during capability detection does not retain the RPC connection', async t => {
  const gate = deferred(); const f = await fixture(t, { probe: () => gate.promise });
  const checking = f.adapter.health(); await new Promise(resolve => setImmediate(resolve));
  await f.adapter.close(); gate.resolve({ pageContext: true });
  assert.equal((await checking).ready, false); assert.equal(f.rpc.closed, true);
  assert.equal(f.adapter.capabilities.pageContext, false);
});
