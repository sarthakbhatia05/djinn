// test/settingsStore.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSettingsStore, normalizePath } = require('../server/lib/settingsStore');

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'settings-')), 'settings.json');
}

test('get returns defaults when no file exists', () => {
  const store = createSettingsStore({ filePath: tempFile() });
  assert.deepStrictEqual(store.get(), { assistantName: null, onboardedAt: null, projects: [] });
});

test('update sets assistantName and stamps onboardedAt on first naming', () => {
  const fixed = new Date('2026-07-18T10:00:00.000Z');
  const store = createSettingsStore({ filePath: tempFile(), now: () => fixed });
  const updated = store.update({ assistantName: '  Djinn  ' });
  assert.strictEqual(updated.assistantName, 'Djinn');
  assert.strictEqual(updated.onboardedAt, '2026-07-18T10:00:00.000Z');
});

test('renaming does not overwrite the original onboardedAt', () => {
  let calls = 0;
  const store = createSettingsStore({
    filePath: tempFile(),
    now: () => new Date(calls++ === 0 ? '2026-07-18T10:00:00.000Z' : '2026-07-19T10:00:00.000Z'),
  });
  store.update({ assistantName: 'Djinn' });
  const renamed = store.update({ assistantName: 'Genie' });
  assert.strictEqual(renamed.assistantName, 'Genie');
  assert.strictEqual(renamed.onboardedAt, '2026-07-18T10:00:00.000Z');
});

test('update rejects an empty or non-string assistantName', () => {
  const store = createSettingsStore({ filePath: tempFile() });
  assert.throws(() => store.update({ assistantName: '   ' }));
  assert.throws(() => store.update({ assistantName: 42 }));
});

test('update replaces projects and de-duplicates loosely-equal paths', () => {
  const store = createSettingsStore({ filePath: tempFile() });
  const updated = store.update({ projects: ['D:\\Projects\\demo', 'd:/projects/demo/', 'D:\\Other'] });
  assert.deepStrictEqual(updated.projects, ['D:\\Projects\\demo', 'D:\\Other']);
});

test('update rejects a projects list with non-string entries', () => {
  const store = createSettingsStore({ filePath: tempFile() });
  assert.throws(() => store.update({ projects: ['D:\\ok', 7] }));
  assert.throws(() => store.update({ projects: 'D:\\not-an-array' }));
});

test('isTracked matches case-insensitively across slash styles', () => {
  const store = createSettingsStore({ filePath: tempFile() });
  store.update({ projects: ['D:\\Projects\\demo'] });
  assert.strictEqual(store.isTracked('d:/projects/DEMO'), true);
  assert.strictEqual(store.isTracked('D:\\Projects\\other'), false);
  assert.strictEqual(store.isTracked(null), false);
});

test('empty allowlist tracks nothing', () => {
  const store = createSettingsStore({ filePath: tempFile() });
  assert.strictEqual(store.isTracked('D:\\Projects\\demo'), false);
});

test('addProject appends only when the path is not already tracked', () => {
  const store = createSettingsStore({ filePath: tempFile() });
  store.update({ projects: ['D:\\Projects\\demo'] });
  store.addProject('d:/projects/demo');
  assert.deepStrictEqual(store.get().projects, ['D:\\Projects\\demo']);
  store.addProject('D:\\Projects\\new');
  assert.deepStrictEqual(store.get().projects, ['D:\\Projects\\demo', 'D:\\Projects\\new']);
});

test('settings persist across store instances', () => {
  const filePath = tempFile();
  createSettingsStore({ filePath }).update({ assistantName: 'Djinn', projects: ['D:\\a'] });
  const reloaded = createSettingsStore({ filePath }).get();
  assert.strictEqual(reloaded.assistantName, 'Djinn');
  assert.deepStrictEqual(reloaded.projects, ['D:\\a']);
});

test('normalizePath collapses case, slashes, and trailing separators', () => {
  assert.strictEqual(normalizePath('D:\\Projects\\Demo\\'), 'd:/projects/demo');
  assert.strictEqual(normalizePath('d:/projects/demo'), 'd:/projects/demo');
});
