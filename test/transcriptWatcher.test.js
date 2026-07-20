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

// The returned watcher is an EventEmitter because that is what makes an
// unhandled 'error' event throw — a plain object would hide the very failure
// mode these tests need to cover.
function makeFakeWatch() {
  const active = new Map(); // path -> { listener, closed, watcher }
  const watchFn = (filePath, listener) => {
    const watcher = new EventEmitter();
    const entry = { listener, closed: false, watcher };
    watcher.close = () => { entry.closed = true; };
    active.set(filePath, entry);
    return watcher;
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

// On Windows, fs.watch emits 'error' (typically EPERM) when the watched file is
// renamed or deleted — and Claude Code rotates transcripts under us. An
// EventEmitter with no 'error' listener throws, which with no uncaughtException
// handler takes the whole server down and makes every view fail to fetch.
test('an fs.watch error event is handled instead of crashing the process', () => {
  const { active, ws } = makeSetup();
  ws.emit('message', JSON.stringify({ type: 'watch', sessionId: 'known-1' }));
  const entry = active.get('/transcripts/known-1.jsonl');
  const eperm = Object.assign(new Error('EPERM: operation not permitted, watch'), { code: 'EPERM' });
  assert.doesNotThrow(() => entry.watcher.emit('error', eperm));
});

test('a watcher that errors is torn down so it cannot be reused', () => {
  const { active, ws } = makeSetup();
  ws.emit('message', JSON.stringify({ type: 'watch', sessionId: 'known-1' }));
  const entry = active.get('/transcripts/known-1.jsonl');
  entry.watcher.emit('error', new Error('EPERM'));
  assert.strictEqual(entry.closed, true, 'expected the dead watcher to be closed');
  // Re-watching must be possible after the failure, not blocked by a stale entry.
  ws.emit('message', JSON.stringify({ type: 'watch', sessionId: 'known-1' }));
  active.get('/transcripts/known-1.jsonl').listener();
  assert.deepStrictEqual(ws.sent, [{ type: 'transcript-update', sessionId: 'known-1' }]);
});
