// test/routes.claudeConfig.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createApp } = require('../server/app');

function request(port, method, urlPath) {
  return new Promise((resolve, reject) => {
    http.request({ host: 'localhost', port, path: urlPath, method }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }));
    }).on('error', reject).end();
  });
}

function makeDeps({ claudeUserConfig }) {
  return {
    sessionStore: { listSessions: () => [], listProjects: () => [] },
    claudeCli: { isRunning: () => false, startSession: async () => ({}), sendMessage: async () => ({}) },
    recentDirectories: { add: () => {}, list: () => [] },
    backlogStore: { list: () => [] },
    memoryStore: { getCommon: () => ({ text: '' }), getProject: () => ({ text: '' }) },
    folderPicker: { pickFolder: async () => null },
    filePicker: { pickFile: async () => null },
    slashCommands: { listSlashCommands: () => [] },
    claudeUserConfig,
  };
}

test('GET /api/claude-defaults returns claudeUserConfig.getClaudeUserDefaults()', async () => {
  const deps = makeDeps({
    claudeUserConfig: { getClaudeUserDefaults: () => ({ model: 'sonnet', permissionMode: 'default' }) },
  });
  const server = createApp(deps).listen(0);
  try {
    const { port } = server.address();
    const { status, body } = await request(port, 'GET', '/api/claude-defaults');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { model: 'sonnet', permissionMode: 'default' });
  } finally {
    server.close();
  }
});

test('GET /api/claude-defaults returns nulls when nothing is configured', async () => {
  const deps = makeDeps({
    claudeUserConfig: { getClaudeUserDefaults: () => ({ model: null, permissionMode: null }) },
  });
  const server = createApp(deps).listen(0);
  try {
    const { port } = server.address();
    const { status, body } = await request(port, 'GET', '/api/claude-defaults');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { model: null, permissionMode: null });
  } finally {
    server.close();
  }
});
