// test/claudeCli.test.js
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createClaudeCli } = require('../server/lib/claudeCli');

function fakeSpawn({ stdout, exitCode = 0 }) {
  const calls = [];
  const spawnFn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', exitCode);
    });
    return child;
  };
  spawnFn.calls = calls;
  return spawnFn;
}

test('startSession spawns claude --print and resolves parsed JSON', async () => {
  const spawnFn = fakeSpawn({ stdout: JSON.stringify({ session_id: 'new-1', result: 'done' }) });
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude' });

  const result = await cli.startSession('D:\\Projects\\demo', 'do the thing');

  assert.deepStrictEqual(result, { session_id: 'new-1', result: 'done' });
  assert.strictEqual(spawnFn.calls[0].bin, 'claude');
  assert.deepStrictEqual(spawnFn.calls[0].args, ['--print', 'do the thing', '--output-format', 'json']);
  assert.strictEqual(spawnFn.calls[0].opts.cwd, 'D:\\Projects\\demo');
});

test('sendMessage spawns claude --resume with the session id', async () => {
  const spawnFn = fakeSpawn({ stdout: JSON.stringify({ session_id: 'abc', result: 'ok' }) });
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude' });

  await cli.sendMessage('abc', 'D:\\Projects\\demo', 'keep going');

  assert.deepStrictEqual(spawnFn.calls[0].args, ['--resume', 'abc', '--print', 'keep going', '--output-format', 'json']);
});

test('startSession with no options leaves args unchanged from current behavior', async () => {
  const spawnFn = fakeSpawn({ stdout: '{}' });
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude' });

  await cli.startSession('D:\\Projects\\demo', 'do the thing', {});

  assert.deepStrictEqual(spawnFn.calls[0].args, ['--print', 'do the thing', '--output-format', 'json']);
});

test('startSession appends --model when options.model is given', async () => {
  const spawnFn = fakeSpawn({ stdout: '{}' });
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude' });

  await cli.startSession('D:\\Projects\\demo', 'do the thing', { model: 'claude-opus-4' });

  assert.deepStrictEqual(spawnFn.calls[0].args, ['--print', 'do the thing', '--output-format', 'json', '--model', 'claude-opus-4']);
});

test('startSession appends --permission-mode when options.permissionMode is given', async () => {
  const spawnFn = fakeSpawn({ stdout: '{}' });
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude' });

  await cli.startSession('D:\\Projects\\demo', 'do the thing', { permissionMode: 'plan' });

  assert.deepStrictEqual(spawnFn.calls[0].args, ['--print', 'do the thing', '--output-format', 'json', '--permission-mode', 'plan']);
});

test('startSession appends both --model and --permission-mode when both are given', async () => {
  const spawnFn = fakeSpawn({ stdout: '{}' });
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude' });

  await cli.startSession('D:\\Projects\\demo', 'do the thing', { model: 'claude-sonnet-4', permissionMode: 'acceptEdits' });

  assert.deepStrictEqual(
    spawnFn.calls[0].args,
    ['--print', 'do the thing', '--output-format', 'json', '--model', 'claude-sonnet-4', '--permission-mode', 'acceptEdits']
  );
});

test('sendMessage with no options leaves args unchanged from current behavior', async () => {
  const spawnFn = fakeSpawn({ stdout: '{}' });
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude' });

  await cli.sendMessage('abc', 'D:\\Projects\\demo', 'keep going', {});

  assert.deepStrictEqual(spawnFn.calls[0].args, ['--resume', 'abc', '--print', 'keep going', '--output-format', 'json']);
});

test('sendMessage appends --model and --permission-mode when given', async () => {
  const spawnFn = fakeSpawn({ stdout: '{}' });
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude' });

  await cli.sendMessage('abc', 'D:\\Projects\\demo', 'keep going', { model: 'claude-haiku-4', permissionMode: 'bypassPermissions' });

  assert.deepStrictEqual(
    spawnFn.calls[0].args,
    ['--resume', 'abc', '--print', 'keep going', '--output-format', 'json', '--model', 'claude-haiku-4', '--permission-mode', 'bypassPermissions']
  );
});

test('empty-string model/permissionMode are treated as absent (no flags appended)', async () => {
  const spawnFn = fakeSpawn({ stdout: '{}' });
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude' });

  await cli.startSession('D:\\Projects\\demo', 'do the thing', { model: '', permissionMode: '' });

  assert.deepStrictEqual(spawnFn.calls[0].args, ['--print', 'do the thing', '--output-format', 'json']);
});

test('isRunning is true while the process is active and false after it closes', async () => {
  let resolveClose;
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    resolveClose = () => {
      child.stdout.emit('data', Buffer.from('{}'));
      child.emit('close', 0);
    };
    return child;
  };
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude' });

  const promise = cli.sendMessage('abc', 'D:\\Projects\\demo', 'go');
  assert.strictEqual(cli.isRunning('abc'), true);
  resolveClose();
  await promise;
  assert.strictEqual(cli.isRunning('abc'), false);
});

test('rejects when claude exits non-zero', async () => {
  const spawnFn = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      child.stderr.emit('data', Buffer.from('boom'));
      child.emit('close', 1);
    });
    return child;
  };
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude' });

  await assert.rejects(() => cli.startSession('D:\\demo', 'x'), /claude exited with code 1/);
});

test('onStatusChange fires running then idle', async () => {
  const spawnFn = fakeSpawn({ stdout: '{}' });
  const events = [];
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude', onStatusChange: (id, status) => events.push(status) });
  await cli.sendMessage('abc', 'D:\\demo', 'go');
  assert.deepStrictEqual(events, ['running', 'idle']);
});

test('getActiveCount is 0 initially, 1 while a run is in flight, and 0 after it settles', async () => {
  let resolveClose;
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    resolveClose = () => {
      child.stdout.emit('data', Buffer.from('{}'));
      child.emit('close', 0);
    };
    return child;
  };
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude' });

  assert.strictEqual(cli.getActiveCount(), 0);
  const promise = cli.startSession('D:\\Projects\\demo', 'go');
  assert.strictEqual(cli.getActiveCount(), 1);
  assert.strictEqual(cli.getActiveIds().length, 1);
  resolveClose();
  await promise;
  assert.strictEqual(cli.getActiveCount(), 0);
});

test('cancel kills the running child, resolves false->true correctly, and rejects the pending promise with a cancelled flag', async () => {
  let killed = false;
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      killed = true;
      process.nextTick(() => child.emit('close', null));
    };
    return child;
  };
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude' });

  const promise = cli.startSession('D:\\demo', 'go');
  const [trackId] = cli.getActiveIds();

  const result = cli.cancel(trackId);

  assert.strictEqual(result, true);
  assert.strictEqual(killed, true);
  await assert.rejects(promise, (err) => err.cancelled === true);
  assert.strictEqual(cli.isRunning(trackId), false);
});

test('cancel returns false when trackId is not running', () => {
  const spawnFn = fakeSpawn({ stdout: '{}' });
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude' });
  assert.strictEqual(cli.cancel('never-started'), false);
});

test('cancel still drives onStatusChange to idle (close handler cleanup fires on kill)', async () => {
  const events = [];
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { process.nextTick(() => child.emit('close', null)); };
    return child;
  };
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude', onStatusChange: (id, status) => events.push(status) });

  const promise = cli.startSession('D:\\demo', 'go');
  const [trackId] = cli.getActiveIds();
  cli.cancel(trackId);
  await promise.catch(() => {});

  assert.deepStrictEqual(events, ['running', 'idle']);
});

test('onStatusChange fires idle only once when spawn errors then closes', async () => {
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      child.emit('error', new Error('spawn ENOENT'));
      child.emit('close', 1);   // Node emits close after error on spawn failure
    });
    return child;
  };
  const events = [];
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude', onStatusChange: (id, status) => events.push(status) });
  await cli.startSession('D:\\demo', 'go').catch(() => {});
  assert.deepStrictEqual(events, ['running', 'idle']);
});
