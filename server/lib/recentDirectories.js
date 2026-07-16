// server/lib/recentDirectories.js
const { readJson, writeJson } = require('./jsonStore');

const MAX_ENTRIES = 10;

function createRecentDirectories({ filePath }) {
  function list() {
    return readJson(filePath, []);
  }

  function add(dirPath) {
    const withoutDuplicate = list().filter((d) => d.toLowerCase() !== dirPath.toLowerCase());
    const updated = [dirPath, ...withoutDuplicate].slice(0, MAX_ENTRIES);
    writeJson(filePath, updated);
    return updated;
  }

  return { list, add };
}

module.exports = { createRecentDirectories };
