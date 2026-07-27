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

  const projectFolder = 'D--Projects-acme-acme-web';
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
      'D:/Projects/acme/acme-web': { lastSessionId: sessionId },
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
  assert.strictEqual(sessions[0].projectPath, 'D:/Projects/acme/acme-web');
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
  fs.mkdirSync(path.join(claudeHomeDir, 'D--Projects-acme-acme-web', 'not-a-session'));
  const store = createSessionStore({ claudeHomeDir, registryPath });
  assert.strictEqual(store.listSessions().length, 1);
});

test('listProjects groups sessions by resolved project path', () => {
  const { claudeHomeDir, registryPath } = makeFixture();
  const store = createSessionStore({ claudeHomeDir, registryPath });
  const projects = store.listProjects();
  assert.strictEqual(projects.length, 1);
  assert.strictEqual(projects[0].projectPath, 'D:/Projects/acme/acme-web');
  assert.strictEqual(projects[0].sessionCount, 1);
});

test('listSessions degrades gracefully when the registry file is malformed JSON', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionstore-'));
  const claudeHomeDir = path.join(root, 'projects');
  const registryPath = path.join(root, 'claude.json');
  const projectDir = path.join(claudeHomeDir, 'D--Projects-acme-acme-web');
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
  assert.strictEqual(sessions[0].projectName, 'acme-web');
  assert.strictEqual(projects[0].projectName, 'acme-web');
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

// ---------- Scan budget + head-parse caching ----------

test('listSessions resolves a title when the real prompt sits beyond 8KB but within the 64KB budget', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionstore-'));
  const claudeHomeDir = path.join(root, 'projects');
  const registryPath = path.join(root, 'claude.json');
  fs.writeFileSync(registryPath, JSON.stringify({ projects: {} }), 'utf-8');

  // Pad the transcript with >8KB of wrapper/meta lines before the real prompt,
  // mimicking hook-injected context pushing the first real user message deep
  // into the file (the defect this budget increase fixes).
  const paddingLines = [];
  let paddingBytes = 0;
  while (paddingBytes < 12 * 1024) {
    const line = { type: 'user', isMeta: true, message: { role: 'user', content: `<system-reminder>padding ${paddingLines.length} ${'y'.repeat(80)}</system-reminder>` }, sessionId: 'sess-deep' };
    const json = JSON.stringify(line);
    paddingLines.push(line);
    paddingBytes += json.length + 1;
  }

  writeSession(claudeHomeDir, 'D--Unknown-Path', 'sess-deep', [
    { type: 'mode', mode: 'normal', sessionId: 'sess-deep' },
    ...paddingLines,
    { type: 'user', message: { role: 'user', content: 'the real prompt buried past 8KB' }, sessionId: 'sess-deep' },
  ]);

  const store = createSessionStore({ claudeHomeDir, registryPath });
  const sessions = store.listSessions();
  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0].title, 'the real prompt buried past 8KB');
});

test('listSessions caches head-parse results and invalidates when the file changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionstore-'));
  const claudeHomeDir = path.join(root, 'projects');
  const registryPath = path.join(root, 'claude.json');
  fs.writeFileSync(registryPath, JSON.stringify({ projects: {} }), 'utf-8');

  const projectFolder = 'D--Unknown-Path';
  const sessionId = 'sess-cache';
  writeSession(claudeHomeDir, projectFolder, sessionId, [
    { type: 'mode', mode: 'normal', sessionId },
    { type: 'user', message: { role: 'user', content: 'original title text' }, sessionId },
  ]);

  const filePath = path.join(claudeHomeDir, projectFolder, `${sessionId}.jsonl`);
  const originalStatSync = fs.statSync;
  let statCallsForFile = 0;
  fs.statSync = function patchedStatSync(p, ...rest) {
    if (p === filePath) statCallsForFile += 1;
    return originalStatSync.call(fs, p, ...rest);
  };

  const store = createSessionStore({ claudeHomeDir, registryPath });
  try {
    const first = store.listSessions();
    assert.strictEqual(first[0].title, 'original title text');

    const readSyncBefore = fs.readSync;
    let readSyncCalls = 0;
    fs.readSync = function patchedReadSync(...args) {
      readSyncCalls += 1;
      return readSyncBefore.apply(fs, args);
    };
    const second = store.listSessions();
    fs.readSync = readSyncBefore;

    assert.strictEqual(second[0].title, 'original title text');
    assert.strictEqual(readSyncCalls, 0, 'cached entry should skip re-reading the file when mtime/size are unchanged');

    // Mutate the file's content and force a later mtime so the cache must invalidate.
    const newLines = [
      JSON.stringify({ type: 'mode', mode: 'normal', sessionId }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'updated title text' }, sessionId }),
    ];
    fs.writeFileSync(filePath, newLines.join('\n') + '\n', 'utf-8');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(filePath, future, future);

    const third = store.listSessions();
    assert.strictEqual(third[0].title, 'updated title text', 'cache should invalidate and reflect new content after mtime/size change');
  } finally {
    fs.statSync = originalStatSync;
  }
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

// --- readMessages / getTranscriptPath (chat view) ---

function makeChatFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionstore-chat-'));
  const claudeHomeDir = path.join(root, 'projects');
  const registryPath = path.join(root, 'claude.json');
  const projectDir = path.join(claudeHomeDir, 'D--Projects-demo-app');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify({ projects: { 'D:/Projects/demo-app': {} } }), 'utf-8');

  const sessionId = 'chat-session-1';
  const lines = [
    JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta caveat line' }, timestamp: '2026-07-15T10:00:00.000Z' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: '<command-name>/compact</command-name>' }, timestamp: '2026-07-15T10:00:01.000Z' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'please fix the login bug' }, timestamp: '2026-07-15T10:00:02.000Z' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: 'Looking at the auth flow now.' },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } },
    ] }, timestamp: '2026-07-15T10:00:10.000Z' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok 1 - passes' }] }, timestamp: '2026-07-15T10:00:12.000Z' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Edit', input: { file_path: 'D:/Projects/demo-app/auth.js' } },
      { type: 'text', text: 'Fixed. The token check was inverted.' },
    ] }, timestamp: '2026-07-15T10:00:20.000Z' }),
    'not valid json',
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'great, thanks' }, timestamp: '2026-07-15T10:01:00.000Z' }),
  ];
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), lines.join('\n') + '\n', 'utf-8');
  return { claudeHomeDir, registryPath, sessionId, projectDir };
}

test('readMessages returns the conversation with wrappers, meta lines, and tool results filtered out', () => {
  const { claudeHomeDir, registryPath, sessionId } = makeChatFixture();
  const store = createSessionStore({ claudeHomeDir, registryPath });
  const messages = store.readMessages(sessionId);

  assert.deepStrictEqual(messages.map((m) => [m.role, m.kind || null]), [
    ['user', null],
    ['assistant', null],
    ['assistant', 'tool'],
    ['assistant', 'tool'],
    ['assistant', null],
    ['user', null],
  ]);
  assert.strictEqual(messages[0].text, 'please fix the login bug');
  assert.strictEqual(messages[0].timestamp, '2026-07-15T10:00:02.000Z');
  assert.strictEqual(messages[1].text, 'Looking at the auth flow now.');
  assert.strictEqual(messages[2].text, 'Ran Bash: Run tests');
  assert.strictEqual(messages[3].text, 'Ran Edit: D:/Projects/demo-app/auth.js');
  assert.strictEqual(messages[4].text, 'Fixed. The token check was inverted.');
  assert.strictEqual(messages[5].text, 'great, thanks');
});

test('readMessages returns null for an unknown session', () => {
  const { claudeHomeDir, registryPath } = makeChatFixture();
  const store = createSessionStore({ claudeHomeDir, registryPath });
  assert.strictEqual(store.readMessages('nope'), null);
});

test('readMessages rejects session ids that are not plain tokens', () => {
  const { claudeHomeDir, registryPath } = makeChatFixture();
  const store = createSessionStore({ claudeHomeDir, registryPath });
  assert.strictEqual(store.readMessages('../../etc/passwd'), null);
  assert.strictEqual(store.readMessages('a/b'), null);
});

test('getTranscriptPath locates the transcript file for a known session', () => {
  const { claudeHomeDir, registryPath, sessionId, projectDir } = makeChatFixture();
  const store = createSessionStore({ claudeHomeDir, registryPath });
  assert.strictEqual(store.getTranscriptPath(sessionId), path.join(projectDir, `${sessionId}.jsonl`));
  assert.strictEqual(store.getTranscriptPath('missing'), null);
});

test('listSessions survives a project folder deleted mid-scan (readdir race)', () => {
  const { claudeHomeDir, registryPath } = makeFixture();
  // Simulate the race: a folder that exists in the outer readdir but whose
  // contents can't be read. A file where a directory is expected produces
  // ENOTDIR from readdirSync, same failure shape as a folder deleted between
  // the two readdir calls.
  fs.writeFileSync(path.join(claudeHomeDir, 'ghost-folder'), 'not a directory', 'utf-8');
  const realReaddirSync = fs.readdirSync;
  fs.readdirSync = function patched(dir, opts) {
    const result = realReaddirSync.call(fs, dir, opts);
    if (dir === claudeHomeDir) {
      result.push(new (class { name = 'ghost-folder'; isDirectory() { return true; } isFile() { return false; } })());
    }
    return result;
  };
  try {
    const store = createSessionStore({ claudeHomeDir, registryPath });
    const sessions = store.listSessions();
    assert.strictEqual(sessions.length, 1);
  } finally {
    fs.readdirSync = realReaddirSync;
  }
});

// Regression: a session started in a directory that ~/.claude.json has never
// heard of used to resolve to nothing. It reported pathResolved:false, which
// meant the tracked-projects filter in routes/sessions.js compared the encoded
// folder name against an absolute path, never matched, and dropped the session
// from the dashboard permanently — including sessions the dashboard had just
// created itself and explicitly added to the tracked list.
test('listSessions resolves a project the registry does not know from extraProjectPaths', () => {
  const { claudeHomeDir, registryPath } = makeFixture();
  // An empty registry is the worst case: no key can possibly match.
  fs.writeFileSync(registryPath, JSON.stringify({ projects: {} }), 'utf-8');

  const withoutExtra = createSessionStore({ claudeHomeDir, registryPath }).listSessions();
  assert.strictEqual(withoutExtra[0].pathResolved, false);
  assert.strictEqual(withoutExtra[0].projectPath, 'D--Projects-acme-acme-web');

  const store = createSessionStore({
    claudeHomeDir,
    registryPath,
    extraProjectPaths: () => ['D:/Projects/acme/acme-web'],
  });
  const sessions = store.listSessions();
  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0].pathResolved, true);
  assert.strictEqual(sessions[0].projectPath, 'D:/Projects/acme/acme-web');
  // A real path also means the name stops being the encoded folder string.
  assert.strictEqual(sessions[0].projectName, 'acme-web');
});

test('listSessions prefers the registry spelling over a tracked-projects one', () => {
  const { claudeHomeDir, registryPath } = makeFixture();
  const store = createSessionStore({
    claudeHomeDir,
    registryPath,
    extraProjectPaths: () => ['d:\\projects\\acme\\acme-web'],
  });
  assert.strictEqual(store.listSessions()[0].projectPath, 'D:/Projects/acme/acme-web');
});

test('listSessions survives extraProjectPaths throwing', () => {
  const { claudeHomeDir, registryPath } = makeFixture();
  const store = createSessionStore({
    claudeHomeDir,
    registryPath,
    extraProjectPaths: () => { throw new Error('settings.json is corrupt'); },
  });
  const sessions = store.listSessions();
  // Degrades to registry-only resolution rather than taking the list down.
  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0].projectPath, 'D:/Projects/acme/acme-web');
});
