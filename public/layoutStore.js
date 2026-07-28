// public/layoutStore.js
// Pure layout rules for the multi-pane workbench: which sessions are on
// screen, in what order, at what relative width, and which one has focus.
// Kept free of DOM access so it can be unit-tested under node --test (see the
// guarded export at the bottom, same convention as format.js and
// sessionSelect.js).
//
// Every function returns a NEW layout and never mutates its argument. That is
// not stylistic: the renderer diffs the previous layout against the next one to
// decide which panes to create and destroy, and in-place mutation would make
// those two the same object.

// Four panes is the cap, derived rather than picked. A chat pane stops being
// readable below ~320px, and the shell spends 224px on the sidebar:
//   224 + 4*320 + 3 dividers = 1507px. Below that the renderer steps the cap
// down (3 -> 1186px, 2 -> 865px) rather than letting panes shrink past use.
const MAX_PANES = 4;

function createLayout() {
  return { panes: [], focusedId: null, minimized: [] };
}

function clone(layout) {
  return {
    panes: layout.panes.map((p) => ({ sessionId: p.sessionId, flex: p.flex })),
    focusedId: layout.focusedId,
    minimized: layout.minimized.slice(),
  };
}

function indexOf(layout, sessionId) {
  return layout.panes.findIndex((p) => p.sessionId === sessionId);
}

function focusPane(layout, sessionId) {
  if (indexOf(layout, sessionId) === -1) return layout;
  const next = clone(layout);
  next.focusedId = sessionId;
  return next;
}

// At the cap, opening another session replaces the focused pane rather than
// refusing. Refusing would mean a click that visibly does nothing; the user
// asked to see this session, so they get it, in the slot they were looking at.
function addPane(layout, sessionId, options) {
  const max = (options && typeof options.max === 'number') ? options.max : MAX_PANES;
  if (indexOf(layout, sessionId) !== -1) return focusPane(layout, sessionId);

  const next = clone(layout);
  next.minimized = next.minimized.filter((id) => id !== sessionId);

  if (next.panes.length >= max) {
    const target = Math.max(0, indexOf(next, next.focusedId));
    next.panes[target] = { sessionId, flex: next.panes[target].flex };
  } else {
    next.panes.push({ sessionId, flex: 1 });
  }
  next.focusedId = sessionId;
  return next;
}

function replaceFocused(layout, sessionId) {
  if (layout.panes.length === 0) return addPane(layout, sessionId);
  if (indexOf(layout, sessionId) !== -1) return focusPane(layout, sessionId);
  const next = clone(layout);
  const target = Math.max(0, indexOf(next, next.focusedId));
  next.panes[target] = { sessionId, flex: next.panes[target].flex };
  next.minimized = next.minimized.filter((id) => id !== sessionId);
  next.focusedId = sessionId;
  return next;
}

// Focus moves left because that is where the eye already is when you close
// something — falling back to the right only when there is no left.
function refocusAfterRemoval(next, removedIndex, wasFocused) {
  if (!wasFocused) return;
  if (next.panes.length === 0) { next.focusedId = null; return; }
  const at = Math.min(Math.max(removedIndex - 1, 0), next.panes.length - 1);
  next.focusedId = next.panes[at].sessionId;
}

function closePane(layout, sessionId) {
  const at = indexOf(layout, sessionId);
  if (at === -1) return layout;
  const next = clone(layout);
  next.panes.splice(at, 1);
  refocusAfterRemoval(next, at, layout.focusedId === sessionId);
  return next;
}

function minimizePane(layout, sessionId) {
  const at = indexOf(layout, sessionId);
  if (at === -1) return layout;
  const next = clone(layout);
  next.panes.splice(at, 1);
  if (!next.minimized.includes(sessionId)) next.minimized.push(sessionId);
  refocusAfterRemoval(next, at, layout.focusedId === sessionId);
  return next;
}

function restorePane(layout, sessionId, options) {
  return addPane(layout, sessionId, options);
}

// Both neighbours move in one call: a divider drag conserves the total width
// between the two panes it sits between, and applying that as two separate
// updates would render an intermediate frame where the widths don't add up.
function resizePane(layout, sessionId, flex, neighbourId, neighbourFlex) {
  const a = indexOf(layout, sessionId);
  const b = indexOf(layout, neighbourId);
  if (a === -1 || b === -1) return layout;
  const valid = (n) => typeof n === 'number' && isFinite(n) && n > 0;
  if (!valid(flex) || !valid(neighbourFlex)) return layout;
  const next = clone(layout);
  next.panes[a].flex = flex;
  next.panes[b].flex = neighbourFlex;
  return next;
}

function serialize(layout) {
  return {
    panes: layout.panes.map((p) => ({ sessionId: p.sessionId, flex: p.flex })),
    focusedId: layout.focusedId,
    minimized: layout.minimized.slice(),
  };
}

// Anything can be in localStorage: a older shape, a truncated write, a value a
// user pasted in by hand. Rebuild defensively and drop whatever no longer
// refers to a session the server still reports — the same pruning rule drafts
// already follow.
function hydrate(raw, knownSessionIds, options) {
  const max = (options && typeof options.max === 'number') ? options.max : MAX_PANES;
  const known = new Set(Array.isArray(knownSessionIds) ? knownSessionIds : []);
  const layout = createLayout();
  if (!raw || typeof raw !== 'object') return layout;

  const rawPanes = Array.isArray(raw.panes) ? raw.panes : [];
  for (const pane of rawPanes) {
    if (layout.panes.length >= max) break;
    if (!pane || typeof pane !== 'object') continue;
    if (typeof pane.sessionId !== 'string' || !known.has(pane.sessionId)) continue;
    if (layout.panes.some((p) => p.sessionId === pane.sessionId)) continue;
    const flex = (typeof pane.flex === 'number' && isFinite(pane.flex) && pane.flex > 0) ? pane.flex : 1;
    layout.panes.push({ sessionId: pane.sessionId, flex });
  }

  const rawMin = Array.isArray(raw.minimized) ? raw.minimized : [];
  layout.minimized = rawMin.filter((id) =>
    typeof id === 'string' && known.has(id) && !layout.panes.some((p) => p.sessionId === id));

  const focusSurvived = typeof raw.focusedId === 'string'
    && layout.panes.some((p) => p.sessionId === raw.focusedId);
  layout.focusedId = focusSurvived ? raw.focusedId
    : (layout.panes.length > 0 ? layout.panes[0].sessionId : null);

  return layout;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MAX_PANES,
    createLayout,
    addPane,
    replaceFocused,
    closePane,
    focusPane,
    resizePane,
    minimizePane,
    restorePane,
    serialize,
    hydrate,
  };
}
