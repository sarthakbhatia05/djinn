// test/sessionSelect.test.js
const test = require('node:test');
const assert = require('node:assert');
const { selectSessions } = require('../public/sessionSelect.js');

function session(id, lastActivity, projectPath, isRunning = false) {
  return { id, lastActivity, projectPath, isRunning };
}

// Deliberately out of order so a passing sort test proves real work.
const SESSIONS = [
  session('b', '2026-07-14T10:00:00.000Z', 'D:/repos/beta'),
  session('d', '2026-07-16T10:00:00.000Z', 'D:/repos/delta'),
  session('a', '2026-07-13T10:00:00.000Z', 'D:/repos/alpha'),
  session('c', '2026-07-15T10:00:00.000Z', 'D:/repos/beta'),
];

const ids = (list) => list.map((s) => s.id);

test('returns an empty array for an empty input list', () => {
  assert.deepStrictEqual(selectSessions([], { sort: 'newest', projectFilter: [], limit: 6 }), []);
});

test('tolerates a missing options object', () => {
  assert.deepStrictEqual(ids(selectSessions(SESSIONS)), ['d', 'c', 'b', 'a']);
});

test('sorts newest-first by last activity', () => {
  const out = selectSessions(SESSIONS, { sort: 'newest', projectFilter: [], limit: 10 });
  assert.deepStrictEqual(ids(out), ['d', 'c', 'b', 'a']);
});

test('sorts oldest-first by last activity', () => {
  const out = selectSessions(SESSIONS, { sort: 'oldest', projectFilter: [], limit: 10 });
  assert.deepStrictEqual(ids(out), ['a', 'b', 'c', 'd']);
});

test('applies the limit to the returned list', () => {
  const out = selectSessions(SESSIONS, { sort: 'newest', projectFilter: [], limit: 2 });
  assert.deepStrictEqual(ids(out), ['d', 'c']);
});

test('a limit of zero returns nothing when no session is running', () => {
  const out = selectSessions(SESSIONS, { sort: 'newest', projectFilter: [], limit: 0 });
  assert.deepStrictEqual(ids(out), []);
});

test('an empty project filter means all projects', () => {
  const out = selectSessions(SESSIONS, { sort: 'newest', projectFilter: [], limit: 10 });
  assert.strictEqual(out.length, 4);
});

test('filters to a single project', () => {
  const out = selectSessions(SESSIONS, { sort: 'newest', projectFilter: ['D:/repos/beta'], limit: 10 });
  assert.deepStrictEqual(ids(out), ['c', 'b']);
});

test('filters to multiple projects at once', () => {
  const out = selectSessions(SESSIONS, {
    sort: 'newest',
    projectFilter: ['D:/repos/alpha', 'D:/repos/delta'],
    limit: 10,
  });
  assert.deepStrictEqual(ids(out), ['d', 'a']);
});

test('pins running sessions first when sorting newest-first', () => {
  const sessions = [...SESSIONS, session('run', '2026-07-01T10:00:00.000Z', 'D:/repos/alpha', true)];
  const out = selectSessions(sessions, { sort: 'newest', projectFilter: [], limit: 10 });
  assert.strictEqual(out[0].id, 'run');
});

test('pins running sessions first when sorting oldest-first', () => {
  const sessions = [...SESSIONS, session('run', '2026-07-20T10:00:00.000Z', 'D:/repos/alpha', true)];
  const out = selectSessions(sessions, { sort: 'oldest', projectFilter: [], limit: 10 });
  assert.strictEqual(out[0].id, 'run');
  assert.deepStrictEqual(ids(out).slice(1), ['a', 'b', 'c', 'd']);
});

test('running sessions survive the limit', () => {
  const sessions = [...SESSIONS, session('run', '2026-07-01T10:00:00.000Z', 'D:/repos/alpha', true)];
  const out = selectSessions(sessions, { sort: 'newest', projectFilter: [], limit: 1 });
  assert.deepStrictEqual(ids(out), ['run', 'd']);
});

test('running sessions survive a project filter that excludes them', () => {
  const sessions = [...SESSIONS, session('run', '2026-07-01T10:00:00.000Z', 'D:/repos/alpha', true)];
  const out = selectSessions(sessions, { sort: 'newest', projectFilter: ['D:/repos/beta'], limit: 10 });
  assert.deepStrictEqual(ids(out), ['run', 'c', 'b']);
});

test('multiple running sessions are themselves ordered by activity', () => {
  const sessions = [
    session('r1', '2026-07-10T10:00:00.000Z', 'D:/repos/alpha', true),
    session('r2', '2026-07-12T10:00:00.000Z', 'D:/repos/alpha', true),
  ];
  assert.deepStrictEqual(ids(selectSessions(sessions, { sort: 'newest', limit: 6 })), ['r2', 'r1']);
});

test('does not mutate the input array', () => {
  const input = [...SESSIONS];
  selectSessions(input, { sort: 'oldest', projectFilter: [], limit: 2 });
  assert.deepStrictEqual(ids(input), ['b', 'd', 'a', 'c']);
});
