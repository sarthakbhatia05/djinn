const crypto = require('crypto');
const { readJson, writeJson } = require('./jsonStore');

function createBacklogStore({ filePath }) {
  function list() {
    return readJson(filePath, []);
  }

  function add({ title, repoPath, priority = 'medium' }) {
    const items = list();
    const item = {
      id: crypto.randomUUID(),
      title,
      repoPath,
      priority,
      done: false,
      createdAt: new Date().toISOString(),
    };
    items.push(item);
    writeJson(filePath, items);
    return item;
  }

  function update(id, changes) {
    const items = list();
    const idx = items.findIndex((i) => i.id === id);
    if (idx === -1) return null;
    items[idx] = { ...items[idx], ...changes };
    writeJson(filePath, items);
    return items[idx];
  }

  // Returns true when an item was actually removed, false when the id wasn't
  // there. The early return is not just a saved write: writeJson does a
  // write-then-rename that intermittently hits EPERM on Windows while an
  // antivirus or indexer holds the handle, so rewriting the whole backlog to
  // produce a byte-identical file put the user's real data at risk for a
  // DELETE of an id that was already gone (a double-click on delete, or a
  // second tab replaying a stale list, does exactly that).
  function remove(id) {
    const items = list();
    const remaining = items.filter((i) => i.id !== id);
    if (remaining.length === items.length) return false;
    writeJson(filePath, remaining);
    return true;
  }

  return { list, add, update, remove };
}

module.exports = { createBacklogStore };
