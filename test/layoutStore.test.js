// test/layoutStore.test.js
const test = require('node:test');
const assert = require('node:assert');
const L = require('../public/layoutStore');

test('createLayout starts empty', () => {
  assert.deepStrictEqual(L.createLayout(), { panes: [], focusedId: null, minimized: [] });
});

test('addPane appends a pane with flex 1 and focuses it', () => {
  const layout = L.addPane(L.addPane(L.createLayout(), 'a'), 'b');
  assert.deepStrictEqual(layout.panes, [{ sessionId: 'a', flex: 1 }, { sessionId: 'b', flex: 1 }]);
  assert.strictEqual(layout.focusedId, 'b');
});

test('addPane does not mutate the layout it was given', () => {
  const before = L.createLayout();
  L.addPane(before, 'a');
  assert.deepStrictEqual(before.panes, [], 'the original is untouched');
});

test('addPane for an already-open session just focuses it', () => {
  const layout = L.addPane(L.addPane(L.addPane(L.createLayout(), 'a'), 'b'), 'a');
  assert.strictEqual(layout.panes.length, 2, 'no duplicate pane');
  assert.strictEqual(layout.focusedId, 'a');
});

test('addPane at the cap replaces the focused pane rather than refusing', () => {
  let layout = L.createLayout();
  for (const id of ['a', 'b', 'c', 'd']) layout = L.addPane(layout, id);
  layout = L.focusPane(layout, 'b');
  layout = L.addPane(layout, 'e');
  assert.strictEqual(layout.panes.length, 4, 'still capped');
  assert.deepStrictEqual(layout.panes.map((p) => p.sessionId), ['a', 'e', 'c', 'd']);
  assert.strictEqual(layout.focusedId, 'e', 'the session the user asked for is the one they get');
});

test('addPane at the cap drops the displaced session rather than parking it in minimized', () => {
  // Locks in the contract a caller must handle itself: at the cap, addPane
  // silently evicts the replaced pane from `panes` without ever adding it to
  // `minimized` (or unwatching it — that's the caller's job, done by the
  // before/after diff in openDetail and the dock chip's click handler).
  let layout = L.createLayout();
  for (const id of ['a', 'b', 'c', 'd']) layout = L.addPane(layout, id);
  layout = L.focusPane(layout, 'b');
  layout = L.addPane(layout, 'e');
  assert.deepStrictEqual(layout.panes.map((p) => p.sessionId), ['a', 'e', 'c', 'd']);
  assert.ok(!layout.panes.some((p) => p.sessionId === 'b'), 'b was displaced out of panes');
  assert.deepStrictEqual(layout.minimized, [], 'b was NOT parked in minimized — the caller must handle it');
});

test('addPane honours an explicit lower cap', () => {
  let layout = L.addPane(L.addPane(L.createLayout(), 'a'), 'b');
  layout = L.addPane(layout, 'c', { max: 2 });
  assert.strictEqual(layout.panes.length, 2);
  assert.deepStrictEqual(layout.panes.map((p) => p.sessionId), ['a', 'c']);
});

test('replaceFocused swaps the focused pane in place', () => {
  let layout = L.addPane(L.addPane(L.createLayout(), 'a'), 'b');
  layout = L.focusPane(layout, 'a');
  layout = L.replaceFocused(layout, 'z');
  assert.deepStrictEqual(layout.panes.map((p) => p.sessionId), ['z', 'b']);
  assert.strictEqual(layout.focusedId, 'z');
});

test('replaceFocused on an empty layout adds the first pane', () => {
  const layout = L.replaceFocused(L.createLayout(), 'a');
  assert.deepStrictEqual(layout.panes.map((p) => p.sessionId), ['a']);
  assert.strictEqual(layout.focusedId, 'a');
});

test('closePane refocuses the pane to its left', () => {
  let layout = L.createLayout();
  for (const id of ['a', 'b', 'c']) layout = L.addPane(layout, id);
  layout = L.focusPane(layout, 'b');
  layout = L.closePane(layout, 'b');
  assert.deepStrictEqual(layout.panes.map((p) => p.sessionId), ['a', 'c']);
  assert.strictEqual(layout.focusedId, 'a');
});

test('closing the leftmost pane refocuses to its right', () => {
  let layout = L.addPane(L.addPane(L.createLayout(), 'a'), 'b');
  layout = L.focusPane(layout, 'a');
  layout = L.closePane(layout, 'a');
  assert.strictEqual(layout.focusedId, 'b');
});

test('closing an unfocused pane leaves focus alone', () => {
  let layout = L.addPane(L.addPane(L.createLayout(), 'a'), 'b');
  layout = L.closePane(layout, 'a');
  assert.strictEqual(layout.focusedId, 'b');
});

test('closing the last pane clears focus', () => {
  const layout = L.closePane(L.addPane(L.createLayout(), 'a'), 'a');
  assert.deepStrictEqual(layout.panes, []);
  assert.strictEqual(layout.focusedId, null);
});

test('resizePane sets both neighbours in one call', () => {
  let layout = L.addPane(L.addPane(L.createLayout(), 'a'), 'b');
  layout = L.resizePane(layout, 'a', 1.4, 'b', 0.6);
  assert.deepStrictEqual(layout.panes, [
    { sessionId: 'a', flex: 1.4 },
    { sessionId: 'b', flex: 0.6 },
  ]);
});

test('resizePane refuses a non-finite or non-positive flex', () => {
  let layout = L.addPane(L.addPane(L.createLayout(), 'a'), 'b');
  const same = L.resizePane(layout, 'a', 0, 'b', 2);
  assert.deepStrictEqual(same.panes, layout.panes, 'a zero-width pane is never a valid outcome');
  const alsoSame = L.resizePane(layout, 'a', NaN, 'b', 1);
  assert.deepStrictEqual(alsoSame.panes, layout.panes);
});

test('minimizePane removes the pane and records it', () => {
  let layout = L.addPane(L.addPane(L.createLayout(), 'a'), 'b');
  layout = L.minimizePane(layout, 'b');
  assert.deepStrictEqual(layout.panes.map((p) => p.sessionId), ['a']);
  assert.deepStrictEqual(layout.minimized, ['b']);
  assert.strictEqual(layout.focusedId, 'a');
});

test('restorePane brings a minimized session back and focuses it', () => {
  let layout = L.minimizePane(L.addPane(L.addPane(L.createLayout(), 'a'), 'b'), 'b');
  layout = L.restorePane(layout, 'b');
  assert.deepStrictEqual(layout.panes.map((p) => p.sessionId), ['a', 'b']);
  assert.deepStrictEqual(layout.minimized, []);
  assert.strictEqual(layout.focusedId, 'b');
});

test('hydrate drops panes whose sessions no longer exist', () => {
  const raw = { panes: [{ sessionId: 'a', flex: 1 }, { sessionId: 'gone', flex: 1 }], focusedId: 'gone', minimized: ['also-gone'] };
  const layout = L.hydrate(raw, ['a']);
  assert.deepStrictEqual(layout.panes.map((p) => p.sessionId), ['a']);
  assert.deepStrictEqual(layout.minimized, []);
  assert.strictEqual(layout.focusedId, 'a', 'focus falls back to a surviving pane');
});

test('hydrate clamps to the cap', () => {
  const raw = { panes: ['a', 'b', 'c', 'd', 'e'].map((sessionId) => ({ sessionId, flex: 1 })), focusedId: 'a', minimized: [] };
  const layout = L.hydrate(raw, ['a', 'b', 'c', 'd', 'e'], { max: 3 });
  assert.deepStrictEqual(layout.panes.map((p) => p.sessionId), ['a', 'b', 'c']);
});

test('hydrate survives garbage', () => {
  for (const raw of [null, undefined, 'nonsense', 42, {}, { panes: 'no' }, { panes: [null, 7] }]) {
    const layout = L.hydrate(raw, ['a']);
    assert.deepStrictEqual(layout.panes, [], `garbage input ${JSON.stringify(raw)} yields an empty layout`);
    assert.strictEqual(layout.focusedId, null);
  }
});

test('serialize then hydrate round-trips', () => {
  let layout = L.createLayout();
  for (const id of ['a', 'b']) layout = L.addPane(layout, id);
  layout = L.resizePane(layout, 'a', 1.3, 'b', 0.7);
  const back = L.hydrate(JSON.parse(JSON.stringify(L.serialize(layout))), ['a', 'b']);
  assert.deepStrictEqual(back, layout);
});
