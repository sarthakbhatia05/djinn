const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBacklogStore } = require('../server/lib/backlogStore');

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-')), 'backlog.json');
}

test('list starts empty', () => {
  const store = createBacklogStore({ filePath: tempFile() });
  assert.deepStrictEqual(store.list(), []);
});

test('add creates an item with defaults and persists it', () => {
  const store = createBacklogStore({ filePath: tempFile() });
  const item = store.add({ title: 'Fix bug', repoPath: 'D:/demo' });
  assert.strictEqual(item.title, 'Fix bug');
  assert.strictEqual(item.priority, 'medium');
  assert.strictEqual(item.done, false);
  assert.strictEqual(store.list().length, 1);
});

test('update changes fields and returns the updated item', () => {
  const store = createBacklogStore({ filePath: tempFile() });
  const item = store.add({ title: 'Fix bug', repoPath: 'D:/demo' });
  const updated = store.update(item.id, { done: true });
  assert.strictEqual(updated.done, true);
  assert.strictEqual(store.list()[0].done, true);
});

test('update returns null for an unknown id', () => {
  const store = createBacklogStore({ filePath: tempFile() });
  assert.strictEqual(store.update('missing', { done: true }), null);
});

test('remove deletes the item and reports true', () => {
  const store = createBacklogStore({ filePath: tempFile() });
  const item = store.add({ title: 'Fix bug', repoPath: 'D:/demo' });
  assert.strictEqual(store.remove(item.id), true);
  assert.deepStrictEqual(store.list(), []);
});

test('remove for an unknown id reports false and does not rewrite the file', () => {
  const filePath = tempFile();
  const store = createBacklogStore({ filePath });
  store.add({ title: 'Fix bug', repoPath: 'D:/demo' });
  const before = fs.statSync(filePath).mtimeMs;

  assert.strictEqual(store.remove('missing'), false);

  // The untouched mtime is the actual assertion: a no-op DELETE must not put
  // the real backlog through jsonStore's write-then-rename at all.
  assert.strictEqual(fs.statSync(filePath).mtimeMs, before);
  assert.strictEqual(store.list().length, 1);
});
