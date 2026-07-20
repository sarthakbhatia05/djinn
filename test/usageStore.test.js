const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUsageStore } = require('../server/lib/usageStore');

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-')), 'usage.json');
}

test('getAll starts empty', () => {
  const store = createUsageStore({ filePath: tempFile() });
  assert.deepStrictEqual(store.getAll(), {
    allTime: { costUsd: 0, inputTokens: 0, outputTokens: 0, callCount: 0 },
    sessions: {},
  });
});

test('recordUsage accumulates across multiple calls to the same session', () => {
  const store = createUsageStore({ filePath: tempFile() });
  store.recordUsage('s1', { costUsd: 0.01, inputTokens: 100, outputTokens: 50 });
  store.recordUsage('s1', { costUsd: 0.02, inputTokens: 200, outputTokens: 75 });
  const session = store.getSession('s1');
  assert.strictEqual(session.costUsd, 0.03);
  assert.strictEqual(session.inputTokens, 300);
  assert.strictEqual(session.outputTokens, 125);
  assert.strictEqual(session.callCount, 2);
});

test('recordUsage sums all-time totals across different sessions', () => {
  const store = createUsageStore({ filePath: tempFile() });
  store.recordUsage('s1', { costUsd: 0.01, inputTokens: 100, outputTokens: 50 });
  store.recordUsage('s2', { costUsd: 0.05, inputTokens: 400, outputTokens: 150 });
  store.recordUsage('s1', { costUsd: 0.01, inputTokens: 100, outputTokens: 50 });
  const { allTime } = store.getAll();
  assert.strictEqual(allTime.costUsd, 0.07);
  assert.strictEqual(allTime.inputTokens, 600);
  assert.strictEqual(allTime.outputTokens, 250);
  assert.strictEqual(allTime.callCount, 3);
});

test('recordUsage defaults missing/malformed fields to 0 instead of throwing', () => {
  const store = createUsageStore({ filePath: tempFile() });
  assert.doesNotThrow(() => store.recordUsage('s1', {}));
  assert.doesNotThrow(() => store.recordUsage('s1', { costUsd: 'oops', inputTokens: null, outputTokens: undefined }));
  assert.doesNotThrow(() => store.recordUsage('s1', undefined));
  const session = store.getSession('s1');
  assert.strictEqual(session.costUsd, 0);
  assert.strictEqual(session.inputTokens, 0);
  assert.strictEqual(session.outputTokens, 0);
  assert.strictEqual(session.callCount, 3);
});

test('recordUsage is a no-op when sessionId is missing', () => {
  const store = createUsageStore({ filePath: tempFile() });
  const result = store.recordUsage(undefined, { costUsd: 1 });
  assert.strictEqual(result, null);
  assert.deepStrictEqual(store.getAll().allTime, { costUsd: 0, inputTokens: 0, outputTokens: 0, callCount: 0 });
});

test('getSession returns zeroed totals for an unknown session', () => {
  const store = createUsageStore({ filePath: tempFile() });
  assert.deepStrictEqual(store.getSession('missing'), { costUsd: 0, inputTokens: 0, outputTokens: 0, callCount: 0 });
});

test('usage persists across store instances backed by the same file', () => {
  const filePath = tempFile();
  const store1 = createUsageStore({ filePath });
  store1.recordUsage('s1', { costUsd: 0.5, inputTokens: 10, outputTokens: 5 });
  const store2 = createUsageStore({ filePath });
  assert.strictEqual(store2.getSession('s1').costUsd, 0.5);
  assert.strictEqual(store2.getAll().allTime.costUsd, 0.5);
});
