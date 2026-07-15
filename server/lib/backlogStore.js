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

  function remove(id) {
    writeJson(filePath, list().filter((i) => i.id !== id));
  }

  return { list, add, update, remove };
}

module.exports = { createBacklogStore };
