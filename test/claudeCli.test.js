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

// Hands every spawned child back to the test instead of closing it on
// nextTick, so a run can be held open while a second one is attempted.
function controllableSpawn() {
  const children = [];
  const spawnFn = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.finish = (stdout = '{}') => {
      child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', 0);
    };
    children.push({ bin, args, opts, child });
    return child;
  };
  spawnFn.children = children;
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

// --- concurrent same-session sends -----------------------------------------
// Before this guard the second send overwrote the first's entry in the running
// map, so the first child to close reported the session idle while the other
// was still running, and cancel() could only reach the newest child.

test('a second concurrent sendMessage for the same session rejects with status 409 and spawns nothing', async () => {
  const spawnFn = controllableSpawn();
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude' });

  const first = cli.sendMessage('abc', 'D:\\demo', 'go');
  await assert.rejects(
    () => cli.sendMessage('abc', 'D:\\demo', 'go again'),
    (err) => err.status === 409 && /already in progress/.test(err.message)
  );

  assert.strictEqual(spawnFn.children.length, 1, 'the rejected send must not spawn a second child');

  spawnFn.children[0].child.finish(JSON.stringify({ result: 'ok' }));
  assert.deepStrictEqual(await first, { result: 'ok' }, 'the first call must still complete normally');
});

test('isRunning stays true until the first send finishes, not when the rejected one is refused', async () => {
  const spawnFn = controllableSpawn();
  const events = [];
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude', onStatusChange: (id, status) => events.push(status) });

  const first = cli.sendMessage('abc', 'D:\\demo', 'go');
  await cli.sendMessage('abc', 'D:\\demo', 'go again').catch(() => {});

  assert.strictEqual(cli.isRunning('abc'), true, 'the refused send must not clear the running flag');
  assert.strictEqual(cli.getActiveCount(), 1);
  assert.deepStrictEqual(events, ['running'], 'the refused send must not broadcast idle');

  spawnFn.children[0].child.finish();
  await first;

  assert.strictEqual(cli.isRunning('abc'), false);
  assert.deepStrictEqual(events, ['running', 'idle']);
});

test('a sequential second send to the same session succeeds once the first has resolved', async () => {
  const spawnFn = controllableSpawn();
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude' });

  const first = cli.sendMessage('abc', 'D:\\demo', 'go');
  spawnFn.children[0].child.finish(JSON.stringify({ turn: 1 }));
  await first;

  const second = cli.sendMessage('abc', 'D:\\demo', 'go again');
  spawnFn.children[1].child.finish(JSON.stringify({ turn: 2 }));

  assert.deepStrictEqual(await second, { turn: 2 });
  assert.strictEqual(spawnFn.children.length, 2);
});

test('the guard is per session id — a different session can run at the same time', async () => {
  const spawnFn = controllableSpawn();
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude' });

  const a = cli.sendMessage('abc', 'D:\\demo', 'go');
  const b = cli.sendMessage('xyz', 'D:\\other', 'go');

  assert.strictEqual(cli.getActiveCount(), 2);
  spawnFn.children[0].child.finish(JSON.stringify({ id: 'abc' }));
  spawnFn.children[1].child.finish(JSON.stringify({ id: 'xyz' }));
  assert.deepStrictEqual(await Promise.all([a, b]), [{ id: 'abc' }, { id: 'xyz' }]);
});

test('two new sessions can still be started concurrently (pending trackIds cannot collide)', async () => {
  const spawnFn = controllableSpawn();
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude' });

  const a = cli.startSession('D:\\one', 'go');
  const b = cli.startSession('D:\\two', 'go');

  assert.strictEqual(spawnFn.children.length, 2, 'the running-map guard must not block a second new session');
  assert.strictEqual(cli.getActiveIds().length, 2);
  spawnFn.children[0].child.finish(JSON.stringify({ session_id: 'n1' }));
  spawnFn.children[1].child.finish(JSON.stringify({ session_id: 'n2' }));
  assert.deepStrictEqual(await Promise.all([a, b]), [{ session_id: 'n1' }, { session_id: 'n2' }]);
});

// --- cancel, then immediately resend ---------------------------------------
// kill() only requests an exit; 'close' lands later. While the entry stayed in
// the running map for that window, the same-id guard refused the next send with
// a 409 blaming a run the user had just stopped.

test('a send issued immediately after cancel is accepted, not refused as still-running', async () => {
  const spawnFn = controllableSpawn();
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude' });

  const first = cli.sendMessage('abc', 'D:\\demo', 'go');
  cli.cancel('abc');

  assert.strictEqual(cli.isRunning('abc'), false, 'cancel must retire the session synchronously');

  // Deliberately before the killed child emits 'close' — that is the window.
  const second = cli.sendMessage('abc', 'D:\\demo', 'go again');
  assert.strictEqual(spawnFn.children.length, 2, 'the resend must be allowed to spawn');

  spawnFn.children[0].child.emit('close', null);   // the cancelled child, late
  await assert.rejects(first, (err) => err.cancelled === true);

  spawnFn.children[1].child.finish(JSON.stringify({ turn: 2 }));
  assert.deepStrictEqual(await second, { turn: 2 });
});

test('the cancelled child closing late cannot evict or idle the run that replaced it', async () => {
  const spawnFn = controllableSpawn();
  const events = [];
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude', onStatusChange: (id, status) => events.push(status) });

  const first = cli.sendMessage('abc', 'D:\\demo', 'go');
  cli.cancel('abc');
  const second = cli.sendMessage('abc', 'D:\\demo', 'go again');

  spawnFn.children[0].child.emit('close', null);
  await first.catch(() => {});

  assert.strictEqual(cli.isRunning('abc'), true, 'the replacement run must survive the old child closing');
  assert.deepStrictEqual(events, ['running', 'idle', 'running'], 'no phantom idle over the live run');

  spawnFn.children[1].child.finish();
  await second;
  assert.deepStrictEqual(events, ['running', 'idle', 'running', 'idle']);
  assert.strictEqual(cli.isRunning('abc'), false);
});

test('stdout split mid multi-byte character still parses (chunk boundary inside an emoji)', async () => {
  const payload = JSON.stringify({ session_id: 'abc', result: 'déjà vu 🎉' });
  const bytes = Buffer.from(payload, 'utf8');
  // Trailing bytes are [4-byte emoji]["][}], so cutting 4 from the end lands
  // two bytes into the emoji. Assert that first, or the test proves nothing.
  const splitAt = bytes.length - 4;
  assert.ok(
    bytes.subarray(0, splitAt).toString('utf8').includes('\uFFFD'),
    'the split must fall inside a character for this test to be meaningful'
  );

  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      child.stdout.emit('data', bytes.subarray(0, splitAt));
      child.stdout.emit('data', bytes.subarray(splitAt));
      child.emit('close', 0);
    });
    return child;
  };
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude' });

  assert.deepStrictEqual(
    await cli.sendMessage('abc', 'D:\\demo', 'go'),
    { session_id: 'abc', result: 'déjà vu 🎉' }
  );
});

test('stderr split mid multi-byte character is reported intact in the exit error', async () => {
  const bytes = Buffer.from('boom — 🎉', 'utf8');
  const splitAt = bytes.length - 2;
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      child.stderr.emit('data', bytes.subarray(0, splitAt));
      child.stderr.emit('data', bytes.subarray(splitAt));
      child.emit('close', 1);
    });
    return child;
  };
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude' });

  await assert.rejects(() => cli.startSession('D:\\demo', 'go'), /claude exited with code 1: boom — 🎉$/);
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
