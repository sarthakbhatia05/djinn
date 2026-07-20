// test/mcpStatus.test.js
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createMcpStatus, parseMcpListOutput } = require('../server/lib/mcpStatus');

function fakeSpawn({ stdout = '', stderr = '', exitCode = 0, emitError = null } = {}) {
  const calls = [];
  const spawnFn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      if (emitError) child.emit('error', emitError);
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', exitCode);
    });
    return child;
  };
  spawnFn.calls = calls;
  return spawnFn;
}

test('parseMcpListOutput parses connected, needs-auth, and pending entries', () => {
  const stdout = [
    'Checking MCP server health…',
    '',
    'claude.ai Spotify: https://mcp-gateway-external-pilot.spotify.net/mcp - ✔ Connected',
    'claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ! Needs authentication',
    'azure-devops: npx -y @azure-devops/mcp InTimeTec-ADO - ⏸ Pending approval',
  ].join('\n');

  const servers = parseMcpListOutput(stdout);

  assert.deepStrictEqual(servers, [
    { name: 'claude.ai Spotify', target: 'https://mcp-gateway-external-pilot.spotify.net/mcp', status: 'connected', statusText: 'Connected' },
    { name: 'claude.ai Gmail', target: 'https://gmailmcp.googleapis.com/mcp/v1', status: 'needs-auth', statusText: 'Needs authentication' },
    { name: 'azure-devops', target: 'npx -y @azure-devops/mcp InTimeTec-ADO', status: 'pending', statusText: 'Pending approval' },
  ]);
});

test('parseMcpListOutput returns an empty array when no servers are configured', () => {
  assert.deepStrictEqual(parseMcpListOutput('Checking MCP server health…\n'), []);
  assert.deepStrictEqual(parseMcpListOutput(''), []);
});

test('parseMcpListOutput falls back to status "unknown" for unrecognized status text', () => {
  const servers = parseMcpListOutput('some-server: some-target - ? Weird state');
  assert.deepStrictEqual(servers, [
    { name: 'some-server', target: 'some-target', status: 'unknown', statusText: 'Weird state' },
  ]);
});

test('parseMcpListOutput classifies by statusText, not the leading symbol — the CLI prints "√" instead of "✔" for Connected under a native Windows console', () => {
  const servers = parseMcpListOutput('claude.ai Spotify: https://mcp.example/mcp - √ Connected');
  assert.deepStrictEqual(servers, [
    { name: 'claude.ai Spotify', target: 'https://mcp.example/mcp', status: 'connected', statusText: 'Connected' },
  ]);
});

test('parseMcpListOutput skips lines missing the ": " or " - " separators', () => {
  const servers = parseMcpListOutput('this is just a stray line of text\nanother-one: no dash here');
  assert.deepStrictEqual(servers, []);
});

test('listServers spawns claude mcp list with the given cwd and resolves parsed servers', async () => {
  const spawnFn = fakeSpawn({ stdout: 'my-server: cmd --flag - ✔ Connected' });
  const mcpStatus = createMcpStatus({ spawnFn, claudeBin: 'claude' });

  const result = await mcpStatus.listServers('D:\\Projects\\demo');

  assert.strictEqual(spawnFn.calls[0].bin, 'claude');
  assert.deepStrictEqual(spawnFn.calls[0].args, ['mcp', 'list']);
  assert.strictEqual(spawnFn.calls[0].opts.cwd, 'D:\\Projects\\demo');
  assert.deepStrictEqual(result, { servers: [{ name: 'my-server', target: 'cmd --flag', status: 'connected', statusText: 'Connected' }] });
});

test('listServers rejects when claude exits non-zero', async () => {
  const spawnFn = fakeSpawn({ stderr: 'boom', exitCode: 1 });
  const mcpStatus = createMcpStatus({ spawnFn, claudeBin: 'claude' });

  await assert.rejects(() => mcpStatus.listServers('D:\\demo'), /claude mcp list exited with code 1.*boom/s);
});

test('listServers rejects when the process errors (e.g. claude not on PATH)', async () => {
  const spawnFn = fakeSpawn({ emitError: new Error('spawn claude ENOENT') });
  const mcpStatus = createMcpStatus({ spawnFn, claudeBin: 'claude' });

  await assert.rejects(() => mcpStatus.listServers('D:\\demo'), /ENOENT/);
});
