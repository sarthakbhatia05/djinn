// server/lib/memoryStore.js
const path = require('path');
const { readJson, writeJson } = require('./jsonStore');
const { encodeProjectPath } = require('./pathEncoding');

function createMemoryStore({ commonFilePath, projectDir }) {
  function getCommon() {
    return readJson(commonFilePath, { text: '' });
  }

  function setCommon(text) {
    const value = { text };
    writeJson(commonFilePath, value);
    return value;
  }

  function projectFilePath(projectPath) {
    return path.join(projectDir, `${encodeProjectPath(projectPath)}.json`);
  }

  function getProject(projectPath) {
    return readJson(projectFilePath(projectPath), { text: '' });
  }

  function setProject(projectPath, text) {
    const value = { text };
    writeJson(projectFilePath(projectPath), value);
    return value;
  }

  return { getCommon, setCommon, getProject, setProject };
}

module.exports = { createMemoryStore };
