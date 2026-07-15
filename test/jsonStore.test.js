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
