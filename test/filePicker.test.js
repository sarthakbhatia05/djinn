// test/filePicker.test.js
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { pickFile } = require('../server/lib/filePicker');

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
  const spawnFn = fakeSpawn('D:\\Projects\\demo\\file.txt\r\n');
  const result = await pickFile({ spawnFn, platform: 'win32' });
  assert.strictEqual(result, 'D:\\Projects\\demo\\file.txt');
  assert.strictEqual(spawnFn.calls[0].bin, 'powershell.exe');
  assert.deepStrictEqual(spawnFn.calls[0].args.slice(0, 2), ['-NoProfile', '-STA']);
});

test('windows: the explicit cancel sentinel resolves null', async () => {
  const spawnFn = fakeSpawn('__CANCELLED__\r\n');
  const result = await pickFile({ spawnFn, platform: 'win32' });
  assert.strictEqual(result, null);
});

// PowerShell exits 0 even when the script errors (non-terminating errors go to
// stderr and leave $LASTEXITCODE at 0). Silence used to be read as a cancel,
// which is exactly how a dialog that never appeared stayed invisible.
test('windows: silence is a failure, not a cancel', async () => {
  const spawnFn = fakeSpawn('');
  await assert.rejects(
    () => pickFile({ spawnFn, platform: 'win32' }),
    /without returning a selection/
  );
});

test('windows: rejects on non-zero exit with stderr', async () => {
  const spawnFn = fakeSpawnSequence({ stderr: 'powershell blew up', exitCode: 2 });
  await assert.rejects(
    () => pickFile({ spawnFn, platform: 'win32' }),
    /powershell blew up/
  );
});

test('windows: rejects when stderr is set even though PowerShell exited 0', async () => {
  const spawnFn = fakeSpawnSequence({ stderr: 'Add-Type : could not load assembly', exitCode: 0 });
  await assert.rejects(
    () => pickFile({ spawnFn, platform: 'win32' }),
    /could not load assembly/
  );
});

test('windows: the dialog is shown with a topmost owner so it cannot hide behind the browser', async () => {
  const spawnFn = fakeSpawn('D:\\Projects\\demo\\file.txt');
  await pickFile({ spawnFn, platform: 'win32' });
  const script = spawnFn.calls[0].args[spawnFn.calls[0].args.length - 1];
  assert.match(script, /TopMost\s*=\s*\$true/);
  assert.match(script, /ShowDialog\(\$owner\)/);
});

test('windows: a hung dialog rejects instead of blocking forever', async () => {
  const killed = [];
  const spawnFn = (bin) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => killed.push(bin);
    return child; // never emits 'close' — models a dialog nobody can see
  };
  spawnFn.calls = [];
  await assert.rejects(
    () => pickFile({ spawnFn, platform: 'win32', timeoutMs: 20 }),
    /timed out/
  );
  assert.deepStrictEqual(killed, ['powershell.exe']);
});

// --- macOS ---

test('darwin: resolves the picked file path', async () => {
  const spawnFn = fakeSpawn('/Users/me/projects/demo/file.txt\n');
  const result = await pickFile({ spawnFn, platform: 'darwin' });
  assert.strictEqual(result, '/Users/me/projects/demo/file.txt');
  assert.strictEqual(spawnFn.calls[0].bin, 'osascript');
  assert.deepStrictEqual(spawnFn.calls[0].args, ['-e', 'POSIX path of (choose file)']);
});

test('darwin: resolves null when the user cancels (osascript non-zero + "User canceled")', async () => {
  const spawnFn = fakeSpawnSequence({
    stderr: 'execution error: User canceled. (-128)\n',
    exitCode: 1,
  });
  const result = await pickFile({ spawnFn, platform: 'darwin' });
  assert.strictEqual(result, null);
});

test('darwin: rejects on non-zero exit that is not a cancel', async () => {
  const spawnFn = fakeSpawnSequence({ stderr: 'execution error: something else broke', exitCode: 1 });
  await assert.rejects(
    () => pickFile({ spawnFn, platform: 'darwin' }),
    /something else broke/
  );
});

// --- Linux ---

test('linux: resolves the path picked via zenity', async () => {
  const spawnFn = fakeSpawn('/home/me/projects/demo/file.txt\n');
  const result = await pickFile({ spawnFn, platform: 'linux' });
  assert.strictEqual(result, '/home/me/projects/demo/file.txt');
  assert.strictEqual(spawnFn.calls.length, 1);
  assert.strictEqual(spawnFn.calls[0].bin, 'zenity');
  assert.deepStrictEqual(spawnFn.calls[0].args, ['--file-selection']);
});

test('linux: exit code 1 from zenity means user cancel -> null', async () => {
  const spawnFn = fakeSpawnSequence({ exitCode: 1 });
  const result = await pickFile({ spawnFn, platform: 'linux' });
  assert.strictEqual(result, null);
  assert.strictEqual(spawnFn.calls.length, 1);
});

test('linux: falls back to kdialog when zenity is not installed', async () => {
  const spawnFn = fakeSpawnSequence(
    { spawnError: enoent('zenity') },
    { stdout: '/home/me/projects/demo/file.txt\n', exitCode: 0 }
  );
  const result = await pickFile({ spawnFn, platform: 'linux' });
  assert.strictEqual(result, '/home/me/projects/demo/file.txt');
  assert.strictEqual(spawnFn.calls.length, 2);
  assert.strictEqual(spawnFn.calls[0].bin, 'zenity');
  assert.strictEqual(spawnFn.calls[1].bin, 'kdialog');
  assert.deepStrictEqual(spawnFn.calls[1].args, ['--getopenfilename']);
});

test('linux: exit code 1 from the kdialog fallback means user cancel -> null', async () => {
  const spawnFn = fakeSpawnSequence(
    { spawnError: enoent('zenity') },
    { exitCode: 1 }
  );
  const result = await pickFile({ spawnFn, platform: 'linux' });
  assert.strictEqual(result, null);
});

test('linux: resolves null when neither zenity nor kdialog is installed', async () => {
  const spawnFn = fakeSpawnSequence(
    { spawnError: enoent('zenity') },
    { spawnError: enoent('kdialog') }
  );
  const result = await pickFile({ spawnFn, platform: 'linux' });
  assert.strictEqual(result, null);
  assert.strictEqual(spawnFn.calls.length, 2);
});

test('linux: a non-ENOENT spawn failure still rejects', async () => {
  const spawnFn = fakeSpawnSequence({
    spawnError: Object.assign(new Error('spawn zenity EACCES'), { code: 'EACCES' }),
  });
  await assert.rejects(() => pickFile({ spawnFn, platform: 'linux' }), /EACCES/);
});
