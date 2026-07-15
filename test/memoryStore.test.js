// test/memoryStore.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemoryStore } = require('../server/lib/memoryStore');

function makeStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-'));
  return createMemoryStore({
    commonFilePath: path.join(root, 'memory-common.json'),
    projectDir: path.join(root, 'memory-projects'),
  });
}

test('getCommon defaults to empty text', () => {
  assert.deepStrictEqual(makeStore().getCommon(), { text: '' });
});

test('setCommon then getCommon round-trips', () => {
  const store = makeStore();
  store.setCommon('shared context');
  assert.deepStrictEqual(store.getCommon(), { text: 'shared context' });
});

test('getProject defaults to empty text for an unseen project', () => {
  const store = makeStore();
  assert.deepStrictEqual(store.getProject('D:/Projects/demo'), { text: '' });
});

test('setProject then getProject round-trips, scoped per path', () => {
  const store = makeStore();
  store.setProject('D:/Projects/demo', 'notes for demo');
  store.setProject('D:/Projects/other', 'notes for other');
  assert.deepStrictEqual(store.getProject('D:/Projects/demo'), { text: 'notes for demo' });
  assert.deepStrictEqual(store.getProject('D:/Projects/other'), { text: 'notes for other' });
});
