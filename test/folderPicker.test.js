// test/folderPicker.test.js
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { pickFolder } = require('../server/lib/folderPicker');

// One fake child process. `spawnError` makes the spawn itself fail (emits
// 'error' instead of 'close'), matching Node's behavior for a missing binary.
function fakeChild({ stdout = '', stderr = '', exitCode = 0, spawnError = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  process.nextTick(() => {
    if (spawnError) {
      child.emit('error', spawnError);
      return;
    }
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', exitCode);
  });
  return child;
}

// Each call to the returned spawnFn consumes the next behavior in sequence
// (the last behavior repeats). Records calls as {bin, args}.
function fakeSpawnSequence(...behaviors) {
  const calls = [];
  const spawnFn = (bin, args) => {
    calls.push({ bin, args });
    const behavior = behaviors[Math.min(calls.length - 1, behaviors.length - 1)];
    return fakeChild(behavior);
  };
  spawnFn.calls = calls;
  return spawnFn;
}

function fakeSpawn(stdout, exitCode = 0) {
  return fakeSpawnSequence({ stdout, exitCode });
}

function enoent(bin) {
  return Object.assign(new Error(`spawn ${bin} ENOENT`), { code: 'ENOENT' });
}

// --- Windows ---

test('resolves the trimmed path printed by the picker script', async () => {
  const spawnFn = fakeSpawn('D:\\Projects\\demo\r\n');
  const result = await pickFolder({ spawnFn, platform: 'win32' });
  assert.strictEqual(result, 'D:\\Projects\\demo');
  assert.strictEqual(spawnFn.calls[0].bin, 'powershell.exe');
  assert.deepStrictEqual(spawnFn.calls[0].args.slice(0, 2), ['-NoProfile', '-STA']);
});

test('resolves null when the dialog prints nothing (user cancelled)', async () => {
  const spawnFn = fakeSpawn('');
  const result = await pickFolder({ spawnFn, platform: 'win32' });
  assert.strictEqual(result, null);
});

test('windows: rejects on non-zero exit with stderr', async () => {
  const spawnFn = fakeSpawnSequence({ stderr: 'powershell blew up', exitCode: 2 });
  await assert.rejects(
    () => pickFolder({ spawnFn, platform: 'win32' }),
    /powershell blew up/
  );
});

// --- macOS ---

test('darwin: resolves the picked path with the trailing slash stripped', async () => {
  const spawnFn = fakeSpawn('/Users/me/projects/demo/\n');
  const result = await pickFolder({ spawnFn, platform: 'darwin' });
  assert.strictEqual(result, '/Users/me/projects/demo');
  assert.strictEqual(spawnFn.calls[0].bin, 'osascript');
  assert.deepStrictEqual(spawnFn.calls[0].args, ['-e', 'POSIX path of (choose folder)']);
});

test('darwin: resolves null when the user cancels (osascript non-zero + "User canceled")', async () => {
  const spawnFn = fakeSpawnSequence({
    stderr: 'execution error: User canceled. (-128)\n',
    exitCode: 1,
  });
  const result = await pickFolder({ spawnFn, platform: 'darwin' });
  assert.strictEqual(result, null);
});

test('darwin: rejects on non-zero exit that is not a cancel', async () => {
  const spawnFn = fakeSpawnSequence({ stderr: 'execution error: something else broke', exitCode: 1 });
  await assert.rejects(
    () => pickFolder({ spawnFn, platform: 'darwin' }),
    /something else broke/
  );
});

// --- Linux ---

test('linux: resolves the path picked via zenity', async () => {
  const spawnFn = fakeSpawn('/home/me/projects/demo\n');
  const result = await pickFolder({ spawnFn, platform: 'linux' });
  assert.strictEqual(result, '/home/me/projects/demo');
  assert.strictEqual(spawnFn.calls.length, 1);
  assert.strictEqual(spawnFn.calls[0].bin, 'zenity');
  assert.deepStrictEqual(spawnFn.calls[0].args, ['--file-selection', '--directory']);
});

test('linux: exit code 1 from zenity means user cancel -> null', async () => {
  const spawnFn = fakeSpawnSequence({ exitCode: 1 });
  const result = await pickFolder({ spawnFn, platform: 'linux' });
  assert.strictEqual(result, null);
  assert.strictEqual(spawnFn.calls.length, 1);
});

test('linux: falls back to kdialog when zenity is not installed', async () => {
  const spawnFn = fakeSpawnSequence(
    { spawnError: enoent('zenity') },
    { stdout: '/home/me/projects/demo\n', exitCode: 0 }
  );
  const result = await pickFolder({ spawnFn, platform: 'linux' });
  assert.strictEqual(result, '/home/me/projects/demo');
  assert.strictEqual(spawnFn.calls.length, 2);
  assert.strictEqual(spawnFn.calls[0].bin, 'zenity');
  assert.strictEqual(spawnFn.calls[1].bin, 'kdialog');
  assert.deepStrictEqual(spawnFn.calls[1].args, ['--getexistingdirectory']);
});

test('linux: exit code 1 from the kdialog fallback means user cancel -> null', async () => {
  const spawnFn = fakeSpawnSequence(
    { spawnError: enoent('zenity') },
    { exitCode: 1 }
  );
  const result = await pickFolder({ spawnFn, platform: 'linux' });
  assert.strictEqual(result, null);
});

test('linux: resolves null when neither zenity nor kdialog is installed', async () => {
  const spawnFn = fakeSpawnSequence(
    { spawnError: enoent('zenity') },
    { spawnError: enoent('kdialog') }
  );
  const result = await pickFolder({ spawnFn, platform: 'linux' });
  assert.strictEqual(result, null);
  assert.strictEqual(spawnFn.calls.length, 2);
});

test('linux: a non-ENOENT spawn failure still rejects', async () => {
  const spawnFn = fakeSpawnSequence({
    spawnError: Object.assign(new Error('spawn zenity EACCES'), { code: 'EACCES' }),
  });
  await assert.rejects(() => pickFolder({ spawnFn, platform: 'linux' }), /EACCES/);
});
