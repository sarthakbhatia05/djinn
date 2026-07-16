// test/format.test.js
const test = require('node:test');
const assert = require('node:assert');
const { formatRelativeTime } = require('../public/format.js');

test('returns "just now" for timestamps under a minute old', () => {
  const now = new Date('2026-07-15T12:00:30.000Z');
  assert.strictEqual(formatRelativeTime('2026-07-15T12:00:00.000Z', now), 'just now');
});

test('returns minutes for timestamps under an hour old', () => {
  const now = new Date('2026-07-15T12:18:00.000Z');
  assert.strictEqual(formatRelativeTime('2026-07-15T12:00:00.000Z', now), '18m');
});

test('returns hours for timestamps under a day old', () => {
  const now = new Date('2026-07-15T15:00:00.000Z');
  assert.strictEqual(formatRelativeTime('2026-07-15T12:00:00.000Z', now), '3h');
});

test('returns days for timestamps a day or more old', () => {
  const now = new Date('2026-07-17T12:00:00.000Z');
  assert.strictEqual(formatRelativeTime('2026-07-15T12:00:00.000Z', now), '2d');
});
