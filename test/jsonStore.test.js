const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readJson, writeJson } = require('../server/lib/jsonStore');

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstore-')), 'data.json');
}

test('readJson returns the default value when the file does not exist', () => {
  const file = tempFile();
  assert.deepStrictEqual(readJson(file, { items: [] }), { items: [] });
});

test('writeJson then readJson round-trips the value', () => {
  const file = tempFile();
  writeJson(file, { items: [1, 2, 3] });
  assert.deepStrictEqual(readJson(file, null), { items: [1, 2, 3] });
});

test('writeJson creates parent directories if missing', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstore-'));
  const nested = path.join(base, 'a', 'b', 'data.json');
  writeJson(nested, { ok: true });
  assert.deepStrictEqual(readJson(nested, null), { ok: true });
});

test('writeJson retries the rename on transient EPERM and succeeds', () => {
  const file = tempFile();
  let calls = 0;
  const renameFn = (tmpPath, destPath) => {
    calls += 1;
    if (calls < 3) {
      const err = new Error('EPERM: operation not permitted, rename');
      err.code = 'EPERM';
      throw err;
    }
    fs.renameSync(tmpPath, destPath);
  };

  writeJson(file, { ok: 'retried' }, { renameFn });

  assert.strictEqual(calls, 3);
  assert.deepStrictEqual(readJson(file, null), { ok: 'retried' });
});

test('writeJson does not retry a non-transient rename error', () => {
  const file = tempFile();
  let calls = 0;
  const renameFn = () => {
    calls += 1;
    const err = new Error('ENOSPC: no space left on device, rename');
    err.code = 'ENOSPC';
    throw err;
  };

  assert.throws(() => writeJson(file, { ok: true }, { renameFn }), /ENOSPC/);
  assert.strictEqual(calls, 1);
});

test('writeJson re-throws EPERM once all retries are exhausted', () => {
  const file = tempFile();
  let calls = 0;
  const renameFn = () => {
    calls += 1;
    const err = new Error('EPERM: operation not permitted, rename');
    err.code = 'EPERM';
    throw err;
  };

  assert.throws(() => writeJson(file, { ok: true }, { renameFn }), /EPERM/);
  assert.ok(calls > 1, 'expected multiple retry attempts before giving up');
  assert.strictEqual(fs.existsSync(`${file}.tmp`), false, 'leftover tmp file should be cleaned up');
});
