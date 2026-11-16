import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile, symlink, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixture, ORIGIN, PUBLISHER } from '../../fixtures/workbuddy-client-fixture.mjs';

const entry = fileURLToPath(new URL('../../../workbuddy-setup.mjs', import.meta.url));
const run = (f, out, extra = []) => spawnSync(process.execPath, [entry, '--out', out, '--runtime-file', f.runtimeFile, '--origin', ORIGIN, '--workspace', f.root, ...extra], { encoding: 'utf8' });

test('setup dry-run writes nothing; explicit export emits absolute import fragment without secrets or dependencies', async t => {
  const f = await fixture(t), out = join(f.root, 'export');
  const preview = run(f, out, ['--dry-run']);
  assert.equal(preview.status, 0, preview.stderr);
  await assert.rejects(stat(out), { code: 'ENOENT' });
  assert.doesNotMatch(preview.stdout + preview.stderr, new RegExp(PUBLISHER));
  const result = run(f, out);
  assert.equal(result.status, 0, result.stderr);
  const connection = JSON.parse(await readFile(join(out, 'connection.json'), 'utf8'));
  assert.deepEqual(connection, { version: 1, runtimeFile: f.runtimeFile, origin: ORIGIN, workspaceRoot: f.root });
  const fragment = JSON.parse(await readFile(join(out, 'mcp.json'), 'utf8'));
  assert.equal(fragment.mcpServers['kuaimai-workbuddy'].command, await import('node:fs/promises').then(fs => fs.realpath(process.execPath)));
  assert.deepEqual(fragment.mcpServers['kuaimai-workbuddy'].args, [fileURLToPath(new URL('../../../mcp-workbuddy.mjs', import.meta.url)), '--config', join(out, 'connection.json')]);
  assert.deepEqual((await readdir(out)).sort(), ['connection.json', 'mcp.json']);
  assert.equal((await stat(out)).mode & 0o777, 0o700);
  assert.equal((await stat(join(out, 'connection.json'))).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(join(out, 'mcp.json'), 'utf8'), new RegExp(PUBLISHER));
  assert.equal(run(f, out).status, 0, 'identical export is a no-op');
  await writeFile(join(out, 'mcp.json'), 'user work');
  assert.notEqual(run(f, out).status, 0);
  assert.equal(await readFile(join(out, 'mcp.json'), 'utf8'), 'user work');
});

test('setup refuses symlink ancestors/output files and non-empty unrelated directories without partial writes', async t => {
  const f = await fixture(t), target = join(f.root, 'target');
  await mkdir(target);
  await symlink(target, join(f.root, 'alias'));
  assert.notEqual(run(f, join(f.root, 'alias', 'new')).status, 0);
  await assert.rejects(stat(join(target, 'new')), { code: 'ENOENT' });
  const out = join(f.root, 'existing');
  await mkdir(out);
  await writeFile(join(out, 'unrelated'), 'preserve');
  assert.notEqual(run(f, out).status, 0);
  assert.deepEqual(await readdir(out), ['unrelated']);
  const symlinked = join(f.root, 'file-link');
  await mkdir(symlinked);
  await symlink(join(f.root, 'connection.json'), join(symlinked, 'connection.json'));
  assert.notEqual(run(f, symlinked).status, 0);
  await assert.rejects(stat(join(symlinked, 'mcp.json')), { code: 'ENOENT' });
});
