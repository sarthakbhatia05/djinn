// test/transcriptWatcher.test.js
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { createTranscriptWatcher } = require('../server/lib/transcriptWatcher');

function makeFakeWs() {
  const ws = new EventEmitter();
  ws.sent = [];
  ws.send = (payload) => ws.sent.push(JSON.parse(payload));
  return ws;
}

function makeFakeWatch() {
  const active = new Map(); // path -> { listener, closed }
  const watchFn = (filePath, listener) => {
    const entry = { listener, closed: false };
    active.set(filePath, entry);
    return { close: () => { entry.closed = true; } };
  };
  return { active, watchFn };
}

function makeSetup({ throttleMs = 5 } = {}) {
  const { active, watchFn } = makeFakeWatch();
  const watcher = createTranscriptWatcher({
    getTranscriptPath: (id) => (id.startsWith('known') ? `/transcripts/${id}.jsonl` : null),
    watchFn,
    throttleMs,
  });
  const ws = makeFakeWs();
  watcher.attach(ws);
  return { active, ws };
}

test('watch starts a file watcher and pushes transcript-update on change', () => {
  const { active, ws } = makeSetup();
  ws.emit('message', JSON.stringify({ type: 'watch', sessionId: 'known-1' }));
  const entry = active.get('/transcripts/known-1.jsonl');
  assert.ok(entry, 'expected a watcher on the transcript path');
  entry.listener();
  assert.deepStrictEqual(ws.sent, [{ type: 'transcript-update', sessionId: 'known-1' }]);
});

test('rapid changes are throttled to a leading nudge plus one trailing nudge', async () => {
  const { active, ws } = makeSetup({ throttleMs: 5 });
  ws.emit('message', JSON.stringify({ type: 'watch', sessionId: 'known-1' }));
  const entry = active.get('/transcripts/known-1.jsonl');
  entry.listener();
  entry.listener();
  entry.listener();
  assert.strictEqual(ws.sent.length, 1);
  await delay(20);
  assert.strictEqual(ws.sent.length, 2);
});

test('unwatch closes the watcher and stops nudges', () => {
  const { active, ws } = makeSetup();
  ws.emit('message', JSON.stringify({ type: 'watch', sessionId: 'known-1' }));
  ws.emit('message', JSON.stringify({ type: 'unwatch', sessionId: 'known-1' }));
  const entry = active.get('/transcripts/known-1.jsonl');
  assert.strictEqual(entry.closed, true);
  entry.listener();
  assert.deepStrictEqual(ws.sent, []);
});

test('disconnect closes every watcher for that connection', () => {
  const { active, ws } = makeSetup();
  ws.emit('message', JSON.stringify({ type: 'watch', sessionId: 'known-1' }));
  ws.emit('message', JSON.stringify({ type: 'watch', sessionId: 'known-2' }));
  ws.emit('close');
  assert.strictEqual(active.get('/transcripts/known-1.jsonl').closed, true);
  assert.strictEqual(active.get('/transcripts/known-2.jsonl').closed, true);
});

test('watching an unknown session or sending malformed input does nothing', () => {
  const { active, ws } = makeSetup();
  ws.emit('message', JSON.stringify({ type: 'watch', sessionId: 'missing-1' }));
  ws.emit('message', 'not json at all');
  ws.emit('message', JSON.stringify({ type: 'watch' }));
  assert.strictEqual(active.size, 0);
  assert.deepStrictEqual(ws.sent, []);
});

test('a duplicate watch for the same session does not stack watchers', () => {
  const { active, ws } = makeSetup();
  ws.emit('message', JSON.stringify({ type: 'watch', sessionId: 'known-1' }));
  ws.emit('message', JSON.stringify({ type: 'watch', sessionId: 'known-1' }));
  active.get('/transcripts/known-1.jsonl').listener();
  assert.strictEqual(ws.sent.length, 1);
});
