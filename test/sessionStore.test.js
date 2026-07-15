// test/sessionStore.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionStore } = require('../server/lib/sessionStore');

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionstore-'));
  const claudeHomeDir = path.join(root, 'projects');
  const registryPath = path.join(root, 'claude.json');

  const projectFolder = 'D--Projects-DFM-Project-oarc-function-app';
  const projectDir = path.join(claudeHomeDir, projectFolder);
  fs.mkdirSync(projectDir, { recursive: true });

  const sessionId = '0f0ab3e8-cb21-423f-ace5-9bdc7b002e94';
  const lines = [
    JSON.stringify({ type: 'mode', mode: 'normal', sessionId }),
    JSON.stringify({
      type: 'user',
      isMeta: false,
      message: { role: 'user', content: 'fix the checkout race condition' },
      gitBranch: 'feat/checkout-refactor',
      sessionId,
      timestamp: '2026-07-15T10:00:00.000Z',
    }),
  ];
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf-8');

  fs.writeFileSync(registryPath, JSON.stringify({
    projects: {
      'D:/Projects/DFM-Project/oarc-function-app': { lastSessionId: sessionId },
    },
  }), 'utf-8');

  return { claudeHomeDir, registryPath, sessionId };
}

test('listSessions finds sessions and resolves the real project path from the registry', () => {
  const { claudeHomeDir, registryPath, sessionId } = makeFixture();
  const store = createSessionStore({ claudeHomeDir, registryPath });
  const sessions = store.listSessions();

  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0].id, sessionId);
  assert.strictEqual(sessions[0].projectPath, 'D:/Projects/DFM-Project/oarc-function-app');
  assert.strictEqual(sessions[0].pathResolved, true);
  assert.strictEqual(sessions[0].gitBranch, 'feat/checkout-refactor');
  assert.strictEqual(sessions[0].title, 'fix the checkout race condition');
});

test('listSessions falls back gracefully when a project folder has no registry match', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionstore-'));
  const claudeHomeDir = path.join(root, 'projects');
  const registryPath = path.join(root, 'claude.json');
  const projectDir = path.join(claudeHomeDir, 'D--Unknown-Path');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'abc.jsonl'), JSON.stringify({ type: 'mode', sessionId: 'abc' }) + '\n', 'utf-8');
  fs.writeFileSync(registryPath, JSON.stringify({ projects: {} }), 'utf-8');

  const store = createSessionStore({ claudeHomeDir, registryPath });
  const sessions = store.listSessions();

  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0].pathResolved, false);
  assert.strictEqual(sessions[0].projectFolder, 'D--Unknown-Path');
});

test('listSessions ignores non-.jsonl entries (e.g. sub-directories)', () => {
  const { claudeHomeDir, registryPath } = makeFixture();
  fs.mkdirSync(path.join(claudeHomeDir, 'D--Projects-DFM-Project-oarc-function-app', 'not-a-session'));
  const store = createSessionStore({ claudeHomeDir, registryPath });
  assert.strictEqual(store.listSessions().length, 1);
});

test('listProjects groups sessions by resolved project path', () => {
  const { claudeHomeDir, registryPath } = makeFixture();
  const store = createSessionStore({ claudeHomeDir, registryPath });
  const projects = store.listProjects();
  assert.strictEqual(projects.length, 1);
  assert.strictEqual(projects[0].projectPath, 'D:/Projects/DFM-Project/oarc-function-app');
  assert.strictEqual(projects[0].sessionCount, 1);
});
