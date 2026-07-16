// test/folderPicker.test.js
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { pickFolder } = require('../server/lib/folderPicker');

function fakeSpawn(stdout, exitCode = 0) {
  const calls = [];
  const spawnFn = (bin, args) => {
    calls.push({ bin, args });
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

test('resolves the trimmed path printed by the picker script', async () => {
  const spawnFn = fakeSpawn('D:\\Projects\\demo\r\n');
  const result = await pickFolder({ spawnFn });
  assert.strictEqual(result, 'D:\\Projects\\demo');
  assert.strictEqual(spawnFn.calls[0].bin, 'powershell.exe');
});

test('resolves null when the dialog prints nothing (user cancelled)', async () => {
  const spawnFn = fakeSpawn('');
  const result = await pickFolder({ spawnFn });
  assert.strictEqual(result, null);
});
