// test/recentDirectories.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRecentDirectories } = require('../server/lib/recentDirectories');

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recentdirs-')), 'recent.json');
}

test('list starts empty', () => {
  const store = createRecentDirectories({ filePath: tempFile() });
  assert.deepStrictEqual(store.list(), []);
});

test('add puts the newest directory first', () => {
  const store = createRecentDirectories({ filePath: tempFile() });
  store.add('D:\\a');
  store.add('D:\\b');
  assert.deepStrictEqual(store.list(), ['D:\\b', 'D:\\a']);
});

test('add de-duplicates case-insensitively and moves to front', () => {
  const store = createRecentDirectories({ filePath: tempFile() });
  store.add('D:\\a');
  store.add('D:\\b');
  store.add('d:\\A');
  assert.deepStrictEqual(store.list(), ['d:\\A', 'D:\\b']);
});

test('add caps the list at 10 entries', () => {
  const store = createRecentDirectories({ filePath: tempFile() });
  for (let i = 0; i < 12; i++) store.add(`D:\\dir${i}`);
  assert.strictEqual(store.list().length, 10);
  assert.strictEqual(store.list()[0], 'D:\\dir11');
});
