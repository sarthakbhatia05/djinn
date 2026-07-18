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

test('listSessions degrades gracefully when the registry file is malformed JSON', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionstore-'));
  const claudeHomeDir = path.join(root, 'projects');
  const registryPath = path.join(root, 'claude.json');
  const projectDir = path.join(claudeHomeDir, 'D--Projects-DFM-Project-oarc-function-app');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'abc.jsonl'), JSON.stringify({ type: 'mode', sessionId: 'abc' }) + '\n', 'utf-8');
  // Registry mid-write / truncated read: not valid JSON.
  fs.writeFileSync(registryPath, '{ not valid json', 'utf-8');

  const store = createSessionStore({ claudeHomeDir, registryPath });
  const sessions = store.listSessions();

  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0].id, 'abc');
  assert.strictEqual(sessions[0].pathResolved, false);
});

// ---------- Defect 1: title extraction from real transcripts ----------

function writeSession(claudeHomeDir, projectFolder, sessionId, lines) {
  const projectDir = path.join(claudeHomeDir, projectFolder);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    'utf-8'
  );
}

test('listSessions extracts a title from a real user message where isMeta is undefined (absent), not false', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionstore-'));
  const claudeHomeDir = path.join(root, 'projects');
  const registryPath = path.join(root, 'claude.json');
  fs.writeFileSync(registryPath, JSON.stringify({ projects: {} }), 'utf-8');

  writeSession(claudeHomeDir, 'D--Unknown-Path', 'sess-1', [
    { type: 'mode', mode: 'normal', sessionId: 'sess-1' },
    {
      type: 'user',
      // isMeta intentionally absent, as in real transcripts.
      message: { role: 'user', content: 'why is the checkout button disabled' },
      sessionId: 'sess-1',
    },
  ]);

  const store = createSessionStore({ claudeHomeDir, registryPath });
  const sessions = store.listSessions();
  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0].title, 'why is the checkout button disabled');
});

test('listSessions skips synthetic wrapper lines and uses the first real human prompt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionstore-'));
  const claudeHomeDir = path.join(root, 'projects');
  const registryPath = path.join(root, 'claude.json');
  fs.writeFileSync(registryPath, JSON.stringify({ projects: {} }), 'utf-8');

  writeSession(claudeHomeDir, 'D--Unknown-Path', 'sess-2', [
    { type: 'mode', mode: 'normal', sessionId: 'sess-2' },
    { type: 'user', message: { role: 'user', content: '<local-command-caveat>some caveat text</local-command-caveat>' }, sessionId: 'sess-2' },
    { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' }, sessionId: 'sess-2' },
    { type: 'user', message: { role: 'user', content: '<command-message>cleared</command-message>' }, sessionId: 'sess-2' },
    { type: 'user', message: { role: 'user', content: '<command-args></command-args>' }, sessionId: 'sess-2' },
    { type: 'user', message: { role: 'user', content: '<system-reminder>reminder text</system-reminder>' }, sessionId: 'sess-2' },
    { type: 'user', message: { role: 'user', content: 'please fix the login bug' }, sessionId: 'sess-2' },
  ]);

  const store = createSessionStore({ claudeHomeDir, registryPath });
  const sessions = store.listSessions();
  assert.strictEqual(sessions[0].title, 'please fix the login bug');
});

test('listSessions skips user lines whose message.content is an array (tool results)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionstore-'));
  const claudeHomeDir = path.join(root, 'projects');
  const registryPath = path.join(root, 'claude.json');
  fs.writeFileSync(registryPath, JSON.stringify({ projects: {} }), 'utf-8');

  writeSession(claudeHomeDir, 'D--Unknown-Path', 'sess-3', [
    { type: 'mode', mode: 'normal', sessionId: 'sess-3' },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'some tool output' }] }, sessionId: 'sess-3' },
    { type: 'user', message: { role: 'user', content: 'the real question about deploys' }, sessionId: 'sess-3' },
  ]);

  const store = createSessionStore({ claudeHomeDir, registryPath });
  const sessions = store.listSessions();
  assert.strictEqual(sessions[0].title, 'the real question about deploys');
});

test('listSessions collapses a long multi-line prompt to one line and truncates to <=120 chars', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionstore-'));
  const claudeHomeDir = path.join(root, 'projects');
  const registryPath = path.join(root, 'claude.json');
  fs.writeFileSync(registryPath, JSON.stringify({ projects: {} }), 'utf-8');

  const longPrompt = 'first line of the prompt\n' + 'x'.repeat(150) + '\nlast line';
  writeSession(claudeHomeDir, 'D--Unknown-Path', 'sess-4', [
    { type: 'mode', mode: 'normal', sessionId: 'sess-4' },
    { type: 'user', message: { role: 'user', content: longPrompt }, sessionId: 'sess-4' },
  ]);

  const store = createSessionStore({ claudeHomeDir, registryPath });
  const sessions = store.listSessions();
  const title = sessions[0].title;
  assert.ok(!title.includes('\n'), 'title should not contain newlines');
  assert.ok(title.length <= 121, `title length ${title.length} should be <= 121 (120 + ellipsis)`);
  assert.ok(title.endsWith('…'), 'truncated title should end with an ellipsis');
  assert.strictEqual(title.slice(0, 25), 'first line of the prompt ');
});

// ---------- Defect 2: friendly projectName ----------

test('listSessions and listProjects derive projectName as the final segment of a resolved path', () => {
  const { claudeHomeDir, registryPath } = makeFixture();
  const store = createSessionStore({ claudeHomeDir, registryPath });
  const sessions = store.listSessions();
  const projects = store.listProjects();
  assert.strictEqual(sessions[0].projectName, 'oarc-function-app');
  assert.strictEqual(projects[0].projectName, 'oarc-function-app');
});

test('listSessions falls back to the raw projectFolder for projectName when the path did not resolve', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionstore-'));
  const claudeHomeDir = path.join(root, 'projects');
  const registryPath = path.join(root, 'claude.json');
  const projectDir = path.join(claudeHomeDir, 'D--Unknown-Path');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'abc.jsonl'), JSON.stringify({ type: 'mode', sessionId: 'abc' }) + '\n', 'utf-8');
  fs.writeFileSync(registryPath, JSON.stringify({ projects: {} }), 'utf-8');

  const store = createSessionStore({ claudeHomeDir, registryPath });
  const sessions = store.listSessions();
  assert.strictEqual(sessions[0].pathResolved, false);
  assert.strictEqual(sessions[0].projectName, 'D--Unknown-Path');
});

test('listSessions derives a sensible projectName for a drive-root-ish resolved path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionstore-'));
  const claudeHomeDir = path.join(root, 'projects');
  const registryPath = path.join(root, 'claude.json');
  const projectFolder = 'D--';
  const projectDir = path.join(claudeHomeDir, projectFolder);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'root.jsonl'), JSON.stringify({ type: 'mode', sessionId: 'root' }) + '\n', 'utf-8');
  fs.writeFileSync(registryPath, JSON.stringify({
    projects: { 'D:\\': { lastSessionId: 'root' } },
  }), 'utf-8');

  const store = createSessionStore({ claudeHomeDir, registryPath });
  const sessions = store.listSessions();
  assert.strictEqual(sessions[0].pathResolved, true);
  assert.ok(sessions[0].projectName && sessions[0].projectName.length > 0, 'projectName should not be empty');
  assert.strictEqual(sessions[0].projectName, 'D:');
});

test('listProjects counts multiple sessions and sorts projects by lastActivity descending', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionstore-'));
  const claudeHomeDir = path.join(root, 'projects');
  const registryPath = path.join(root, 'claude.json');

  // Older project: two sessions, both older mtimes.
  const olderFolder = 'D--Projects-older-app';
  const olderDir = path.join(claudeHomeDir, olderFolder);
  fs.mkdirSync(olderDir, { recursive: true });
  const olderDate = new Date('2026-07-10T00:00:00.000Z');
  for (const id of ['s1', 's2']) {
    const fp = path.join(olderDir, `${id}.jsonl`);
    fs.writeFileSync(fp, JSON.stringify({ type: 'mode', sessionId: id }) + '\n', 'utf-8');
    fs.utimesSync(fp, olderDate, olderDate);
  }

  // Newer project: one session, most-recent mtime.
  const newerFolder = 'D--Projects-newer-app';
  const newerDir = path.join(claudeHomeDir, newerFolder);
  fs.mkdirSync(newerDir, { recursive: true });
  const newerDate = new Date('2026-07-14T00:00:00.000Z');
  const newerFp = path.join(newerDir, 's3.jsonl');
  fs.writeFileSync(newerFp, JSON.stringify({ type: 'mode', sessionId: 's3' }) + '\n', 'utf-8');
  fs.utimesSync(newerFp, newerDate, newerDate);

  fs.writeFileSync(registryPath, JSON.stringify({
    projects: {
      'D:/Projects/older-app': { lastSessionId: 's2' },
      'D:/Projects/newer-app': { lastSessionId: 's3' },
    },
  }), 'utf-8');

  const store = createSessionStore({ claudeHomeDir, registryPath });
  const projects = store.listProjects();

  assert.strictEqual(projects.length, 2);
  // Most-recent project first.
  assert.strictEqual(projects[0].projectPath, 'D:/Projects/newer-app');
  assert.strictEqual(projects[1].projectPath, 'D:/Projects/older-app');
  assert.ok(projects[0].lastActivity > projects[1].lastActivity);
  // Two-session project reports the correct count.
  assert.strictEqual(projects[1].sessionCount, 2);
});
