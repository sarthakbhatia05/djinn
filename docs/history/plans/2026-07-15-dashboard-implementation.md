# Claude Code Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local web app that shows every Claude Code session across the user's tracked projects, lets the user start new sessions or send follow-up instructions from one screen, and adds a dashboard-owned backlog board and memory store — matching the approved mockup at `design/dashboard-mockup-v2.html`.

**Architecture:** A small Node.js/Express backend (`server/`) reads Claude Code's own session transcripts (`~/.claude/projects/**/*.jsonl`) and project registry (`~/.claude.json`, read-only), shells out to the `claude` CLI to start/resume sessions, and owns a small set of JSON files under `data/` for backlog and memory. A plain HTML/CSS/JS frontend (`public/`) served as static files talks to the backend over REST + a WebSocket for live status pushes. No build step, no framework, no database.

**Tech Stack:** Node.js 22 (built-in `node:test` for tests, no test framework dependency), Express 4 for HTTP, `ws` for WebSocket, plain HTML/CSS/JS for the frontend. Two production dependencies total.

## Global Constraints

- Node.js >= 22 (confirmed installed: v22.21.0). Use CommonJS (`require`/`module.exports`), not ESM — keeps `node --test` simple.
- Windows-only for v1. The directory-browse feature shells out to PowerShell's `System.Windows.Forms.FolderBrowserDialog` — this is a deliberate v1 scope decision, not an oversight (spec's Known Risk #5).
- Dependencies limited to `express` and `ws`. No ORM, no SQLite, no bundler, no CSS framework.
- `~/.claude.json` is **read-only** from this app. Never call `fs.writeFileSync` (or any write) on it, under any circumstance — a prior incident this session showed this file is sensitive to hand-edits.
- Dashboard-owned data (backlog, memory, recent directories) lives under `data/` at the project root and is gitignored — it's local, per-machine state, not source.
- Visual design must match `design/dashboard-mockup-v2.html` exactly: CSS custom properties for theming (`--bg`, `--surface`, `--accent`, etc.), Silkscreen/DotGothic16 for eyebrows and counters only, Hanken Grotesk for body text, JetBrains Mono for paths, both light and dark themes via `:root[data-theme]` + `@media (prefers-color-scheme)`.
- Default port 4317, overridable via `PORT` env var.
- Every module that talks to the filesystem, spawns a process, or opens a dialog must accept its dependencies (base paths, a `spawn` function) as constructor options, so tests can inject fakes instead of touching the real `~/.claude` directory or spawning real processes.

---

## File Structure

```
claude-dashboard/
  package.json
  .gitignore
  server/
    index.js                 # entry point: wires real deps, starts HTTP + WS server
    app.js                   # createApp(deps) -> Express app, no side effects
    routes/
      sessions.js
      projects.js
      directories.js
      backlog.js
      memory.js
    lib/
      pathEncoding.js         # encodeProjectPath()
      jsonStore.js             # readJson()/writeJson() — atomic file-backed storage
      sessionStore.js          # scans ~/.claude/projects + ~/.claude.json
      claudeCli.js             # spawns `claude` CLI, tracks running sessions
      folderPicker.js          # PowerShell FolderBrowserDialog wrapper
      backlogStore.js
      memoryStore.js
      recentDirectories.js
  public/
    index.html
    styles.css
    format.js                 # formatRelativeTime() — shared with tests
    app.js                    # fetch calls, rendering, WebSocket wiring
  test/
    pathEncoding.test.js
    jsonStore.test.js
    sessionStore.test.js
    claudeCli.test.js
    backlogStore.test.js
    memoryStore.test.js
    format.test.js
    health.test.js
  data/                        # gitignored — created at runtime
```

---

### Task 1: Project scaffolding — Express app skeleton + health check

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `server/app.js`
- Create: `server/index.js`
- Test: `test/health.test.js`

**Interfaces:**
- Produces: `createApp(deps)` from `server/app.js` — takes a deps object (unused for now), returns an Express app with `GET /api/health` and static file serving from `public/`. Every later task adds routers to this same function.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "claude-dashboard",
  "version": "0.1.0",
  "private": true,
  "description": "Local dashboard for managing Claude Code sessions across projects",
  "main": "server/index.js",
  "scripts": {
    "start": "node server/index.js",
    "test": "node --test test/"
  },
  "engines": {
    "node": ">=22"
  },
  "dependencies": {
    "express": "^4.19.2",
    "ws": "^8.18.0"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
data/
*.tmp
```

- [ ] **Step 3: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` created, no errors.

- [ ] **Step 4: Write `server/app.js`**

```javascript
const express = require('express');
const path = require('path');

function createApp(deps = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/health', (req, res) => {
    res.json({ ok: true });
  });

  return app;
}

module.exports = { createApp };
```

- [ ] **Step 5: Write the failing test**

```javascript
// test/health.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createApp } = require('../server/app');

function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${urlPath}`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

test('GET /api/health returns ok: true', async () => {
  const app = createApp({});
  const server = app.listen(0);
  const { port } = server.address();
  const { status, body } = await getJson(port, '/api/health');
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body, { ok: true });
  server.close();
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test`
Expected: PASS — `GET /api/health returns ok: true` (this is a "write test after code" case since the code is trivial scaffolding; verify it actually exercises the real route by temporarily renaming the route path and confirming the test fails, then rename it back).

- [ ] **Step 7: Write `server/index.js`**

```javascript
const path = require('path');
const http = require('http');
const { createApp } = require('./app');

const PORT = process.env.PORT || 4317;

const app = createApp({});
const server = http.createServer(app);

server.listen(PORT, () => {
  console.log(`Claude Code Dashboard running at http://localhost:${PORT}`);
});
```

- [ ] **Step 8: Verify the server starts**

Run: `npm start` (in one terminal), then in another: `curl http://localhost:4317/api/health`
Expected: `{"ok":true}`. Stop the server with Ctrl+C.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json .gitignore server/app.js server/index.js test/health.test.js
git commit -m "Scaffold Express app with health check"
```

---

### Task 2: Path encoding — match Claude Code's project folder naming

**Files:**
- Create: `server/lib/pathEncoding.js`
- Test: `test/pathEncoding.test.js`

**Interfaces:**
- Produces: `encodeProjectPath(absPath: string): string` — used by `sessionStore.js` (Task 4) and `memoryStore.js` (Task 8).

- [ ] **Step 1: Write the failing test**

```javascript
// test/pathEncoding.test.js
const test = require('node:test');
const assert = require('node:assert');
const { encodeProjectPath } = require('../server/lib/pathEncoding');

test('encodes backslashes, colons, and spaces to hyphens', () => {
  assert.strictEqual(
    encodeProjectPath('D:\\Projects\\acme\\acme-web'),
    'D--Projects-acme-acme-web'
  );
});

test('encodes forward-slash paths the same way (registry keys vary)', () => {
  assert.strictEqual(
    encodeProjectPath('D:/Projects/acme/acme-web'),
    'D--Projects-acme-acme-web'
  );
});

test('encodes spaces in path segments', () => {
  assert.strictEqual(
    encodeProjectPath('D:\\Projects\\contoso\\Data Pipeline App'),
    'D--Projects-contoso-Data-Pipeline-App'
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module '../server/lib/pathEncoding'"

- [ ] **Step 3: Write the implementation**

```javascript
// server/lib/pathEncoding.js
function encodeProjectPath(absPath) {
  return absPath.replace(/[:\\/ ]/g, '-');
}

module.exports = { encodeProjectPath };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all 3 `pathEncoding` tests green.

- [ ] **Step 5: Commit**

```bash
git add server/lib/pathEncoding.js test/pathEncoding.test.js
git commit -m "Add path encoding matching Claude Code's project folder naming"
```

---

### Task 3: JSON store — atomic file-backed read/write

**Files:**
- Create: `server/lib/jsonStore.js`
- Test: `test/jsonStore.test.js`

**Interfaces:**
- Produces: `readJson(filePath: string, defaultValue: any): any`, `writeJson(filePath: string, value: any): void` — used by `backlogStore.js`, `memoryStore.js`, `recentDirectories.js` (Tasks 7, 8, and the directories task).

- [ ] **Step 1: Write the failing test**

```javascript
// test/jsonStore.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readJson, writeJson } = require('../server/lib/jsonStore');

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstore-')), 'data.json');
}

test('readJson returns the default value when the file does not exist', () => {
  const file = tempFile();
  assert.deepStrictEqual(readJson(file, { items: [] }), { items: [] });
});

test('writeJson then readJson round-trips the value', () => {
  const file = tempFile();
  writeJson(file, { items: [1, 2, 3] });
  assert.deepStrictEqual(readJson(file, null), { items: [1, 2, 3] });
});

test('writeJson creates parent directories if missing', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonstore-'));
  const nested = path.join(base, 'a', 'b', 'data.json');
  writeJson(nested, { ok: true });
  assert.deepStrictEqual(readJson(nested, null), { ok: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module '../server/lib/jsonStore'"

- [ ] **Step 3: Write the implementation**

```javascript
// server/lib/jsonStore.js
const fs = require('fs');
const path = require('path');

function readJson(filePath, defaultValue) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return defaultValue;
    throw err;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

module.exports = { readJson, writeJson };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all 3 `jsonStore` tests green.

- [ ] **Step 5: Commit**

```bash
git add server/lib/jsonStore.js test/jsonStore.test.js
git commit -m "Add atomic JSON file store"
```

---

### Task 4: Session store — scan real Claude Code session data

**Files:**
- Create: `server/lib/sessionStore.js`
- Test: `test/sessionStore.test.js`

**Interfaces:**
- Consumes: `encodeProjectPath` from `server/lib/pathEncoding.js` (Task 2).
- Produces: `createSessionStore({ claudeHomeDir, registryPath }): { listSessions(), listProjects() }`.
  - `listSessions()` returns `Array<{ id, projectFolder, projectPath, pathResolved, gitBranch, title, lastActivity, sizeBytes }>` where `lastActivity` is an ISO date string.
  - `listProjects()` returns `Array<{ projectPath, projectFolder, sessionCount, lastActivity }>`, one entry per distinct `projectPath`, sorted by `lastActivity` descending.
  - Both default `claudeHomeDir` to `path.join(os.homedir(), '.claude', 'projects')` and `registryPath` to `path.join(os.homedir(), '.claude.json')` — tests override both with fixture directories so they never touch the real `~/.claude` folder.

This task's tests build a small fixture directory tree under `os.tmpdir()` mirroring the real structure confirmed earlier this session: one folder per encoded project path under `claudeHomeDir`, each containing `*.jsonl` files where each line is a JSON object; a `user` line looks like `{"type":"user","message":{"role":"user","content":"..."},"isMeta":false,"gitBranch":"main",...}`, and a registry file (`registryPath`) shaped like `{"projects": {"<path>": {"lastSessionId": "..."}}}`.

- [ ] **Step 1: Write the failing tests**

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL with "Cannot find module '../server/lib/sessionStore'"

- [ ] **Step 3: Write the implementation**

```javascript
// server/lib/sessionStore.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJson } = require('./jsonStore');
const { encodeProjectPath } = require('./pathEncoding');

const READ_HEAD_BYTES = 8192;

function readHead(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const size = Math.min(READ_HEAD_BYTES, stat.size);
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, 0);
    return buffer.toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

function parseHeadMeta(filePath) {
  const head = readHead(filePath);
  const lines = head.split('\n');
  let gitBranch = null;
  let title = null;

  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!gitBranch && obj.gitBranch) gitBranch = obj.gitBranch;
    if (!title && obj.type === 'user' && obj.isMeta === false && typeof obj.message?.content === 'string') {
      title = obj.message.content;
    }
    if (gitBranch && title) break;
  }

  return { gitBranch, title };
}

function createSessionStore({
  claudeHomeDir = path.join(os.homedir(), '.claude', 'projects'),
  registryPath = path.join(os.homedir(), '.claude.json'),
} = {}) {
  function loadRegistryKeys() {
    const registry = readJson(registryPath, { projects: {} });
    return Object.keys(registry.projects || {});
  }

  function resolveProjectPath(projectFolder, registryKeys) {
    for (const key of registryKeys) {
      if (encodeProjectPath(key).toLowerCase() === projectFolder.toLowerCase()) {
        return key;
      }
    }
    return null;
  }

  function listSessions() {
    if (!fs.existsSync(claudeHomeDir)) return [];
    const registryKeys = loadRegistryKeys();
    const folders = fs.readdirSync(claudeHomeDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    const sessions = [];
    for (const projectFolder of folders) {
      const resolved = resolveProjectPath(projectFolder, registryKeys);
      const projectDir = path.join(claudeHomeDir, projectFolder);
      const files = fs.readdirSync(projectDir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith('.jsonl'));

      for (const file of files) {
        const filePath = path.join(projectDir, file.name);
        const stat = fs.statSync(filePath);
        const { gitBranch, title } = parseHeadMeta(filePath);
        sessions.push({
          id: file.name.replace(/\.jsonl$/, ''),
          projectFolder,
          projectPath: resolved || projectFolder,
          pathResolved: resolved !== null,
          gitBranch,
          title,
          lastActivity: stat.mtime.toISOString(),
          sizeBytes: stat.size,
        });
      }
    }
    return sessions;
  }

  function listProjects() {
    const sessions = listSessions();
    const byPath = new Map();
    for (const s of sessions) {
      const existing = byPath.get(s.projectPath);
      if (!existing) {
        byPath.set(s.projectPath, {
          projectPath: s.projectPath,
          projectFolder: s.projectFolder,
          sessionCount: 1,
          lastActivity: s.lastActivity,
        });
      } else {
        existing.sessionCount += 1;
        if (s.lastActivity > existing.lastActivity) existing.lastActivity = s.lastActivity;
      }
    }
    return [...byPath.values()].sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1));
  }

  return { listSessions, listProjects };
}

module.exports = { createSessionStore };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all 4 `sessionStore` tests green.

- [ ] **Step 5: Commit**

```bash
git add server/lib/sessionStore.js test/sessionStore.test.js
git commit -m "Add session store that scans Claude Code transcripts and registry"
```

---

### Task 5: Claude CLI wrapper — start and resume sessions

**Files:**
- Create: `server/lib/claudeCli.js`
- Test: `test/claudeCli.test.js`

**Interfaces:**
- Produces: `createClaudeCli({ spawnFn, claudeBin, onStatusChange }): { isRunning(sessionId), startSession(cwd, message), sendMessage(sessionId, cwd, message) }`.
  - `startSession`/`sendMessage` return a Promise resolving to the parsed JSON the `claude` CLI printed to stdout (confirmed shape includes `session_id`, `result`, `usage`, `cost` from earlier verification this session).
  - `spawnFn` defaults to `child_process.spawn`; tests inject a fake so no real `claude` binary is invoked.
  - `onStatusChange(sessionId, status)` fires with `status` one of `'running' | 'idle'` — this is what Task 9 (WebSocket) wires to broadcast.

- [ ] **Step 1: Write the failing tests**

```javascript
// test/claudeCli.test.js
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createClaudeCli } = require('../server/lib/claudeCli');

function fakeSpawn({ stdout, exitCode = 0 }) {
  const calls = [];
  const spawnFn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', exitCode);
    });
    return child;
  };
  spawnFn.calls = calls;
  return spawnFn;
}

test('startSession spawns claude --print and resolves parsed JSON', async () => {
  const spawnFn = fakeSpawn({ stdout: JSON.stringify({ session_id: 'new-1', result: 'done' }) });
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude' });

  const result = await cli.startSession('D:\\Projects\\demo', 'do the thing');

  assert.deepStrictEqual(result, { session_id: 'new-1', result: 'done' });
  assert.strictEqual(spawnFn.calls[0].bin, 'claude');
  assert.deepStrictEqual(spawnFn.calls[0].args, ['--print', 'do the thing', '--output-format', 'json']);
  assert.strictEqual(spawnFn.calls[0].opts.cwd, 'D:\\Projects\\demo');
});

test('sendMessage spawns claude --resume with the session id', async () => {
  const spawnFn = fakeSpawn({ stdout: JSON.stringify({ session_id: 'abc', result: 'ok' }) });
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude' });

  await cli.sendMessage('abc', 'D:\\Projects\\demo', 'keep going');

  assert.deepStrictEqual(spawnFn.calls[0].args, ['--resume', 'abc', '--print', 'keep going', '--output-format', 'json']);
});

test('isRunning is true while the process is active and false after it closes', async () => {
  let resolveClose;
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    resolveClose = () => {
      child.stdout.emit('data', Buffer.from('{}'));
      child.emit('close', 0);
    };
    return child;
  };
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude' });

  const promise = cli.sendMessage('abc', 'D:\\Projects\\demo', 'go');
  assert.strictEqual(cli.isRunning('abc'), true);
  resolveClose();
  await promise;
  assert.strictEqual(cli.isRunning('abc'), false);
});

test('rejects when claude exits non-zero', async () => {
  const spawnFn = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      child.stderr.emit('data', Buffer.from('boom'));
      child.emit('close', 1);
    });
    return child;
  };
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude' });

  await assert.rejects(() => cli.startSession('D:\\demo', 'x'), /claude exited with code 1/);
});

test('onStatusChange fires running then idle', async () => {
  const spawnFn = fakeSpawn({ stdout: '{}' });
  const events = [];
  const cli = createClaudeCli({ spawnFn, claudeBin: 'claude', onStatusChange: (id, status) => events.push(status) });
  await cli.sendMessage('abc', 'D:\\demo', 'go');
  assert.deepStrictEqual(events, ['running', 'idle']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL with "Cannot find module '../server/lib/claudeCli'"

- [ ] **Step 3: Write the implementation**

```javascript
// server/lib/claudeCli.js
const { spawn } = require('child_process');

function createClaudeCli({ spawnFn = spawn, claudeBin = 'claude', onStatusChange = () => {} } = {}) {
  const running = new Map();

  function isRunning(sessionId) {
    return running.has(sessionId);
  }

  function runOneShot(args, cwd, trackId) {
    return new Promise((resolve, reject) => {
      const child = spawnFn(claudeBin, args, { cwd });
      running.set(trackId, { child, startedAt: Date.now() });
      onStatusChange(trackId, 'running');

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });

      const finish = (err, value) => {
        running.delete(trackId);
        onStatusChange(trackId, 'idle');
        if (err) reject(err);
        else resolve(value);
      };

      child.on('error', (err) => finish(err));
      child.on('close', (code) => {
        if (code !== 0) {
          finish(new Error(`claude exited with code ${code}: ${stderr}`));
          return;
        }
        try {
          finish(null, JSON.parse(stdout));
        } catch (err) {
          finish(new Error(`failed to parse claude output: ${err.message}`));
        }
      });
    });
  }

  function startSession(cwd, message) {
    const trackId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return runOneShot(['--print', message, '--output-format', 'json'], cwd, trackId);
  }

  function sendMessage(sessionId, cwd, message) {
    return runOneShot(['--resume', sessionId, '--print', message, '--output-format', 'json'], cwd, sessionId);
  }

  return { isRunning, startSession, sendMessage };
}

module.exports = { createClaudeCli };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all 5 `claudeCli` tests green.

- [ ] **Step 5: Commit**

```bash
git add server/lib/claudeCli.js test/claudeCli.test.js
git commit -m "Add claude CLI wrapper for starting and resuming sessions"
```

---

### Task 6: Sessions and projects API routes

**Files:**
- Create: `server/routes/sessions.js`
- Create: `server/routes/projects.js`
- Modify: `server/app.js` (register both routers)
- Test: `test/routes.sessions.test.js`

**Interfaces:**
- Consumes: `sessionStore` (Task 4) and `claudeCli` (Task 5) from `deps`.
- Produces: `GET /api/sessions` → session list with `isRunning` merged in; `POST /api/sessions` `{cwd, message}` → starts a session; `POST /api/sessions/:id/message` `{message}` → resumes; `GET /api/projects` → project list.

- [ ] **Step 1: Write the failing tests**

```javascript
// test/routes.sessions.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createApp } = require('../server/app');

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: 'localhost', port, path: urlPath, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }));
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function makeDeps(overrides = {}) {
  return {
    sessionStore: {
      listSessions: () => [{ id: 's1', projectPath: 'D:/demo', title: 'x', lastActivity: '2026-07-15T00:00:00.000Z' }],
      listProjects: () => [{ projectPath: 'D:/demo', projectFolder: 'D--demo', sessionCount: 1, lastActivity: '2026-07-15T00:00:00.000Z' }],
    },
    claudeCli: {
      isRunning: () => false,
      startSession: async () => ({ session_id: 'new-1', result: 'ok' }),
      sendMessage: async () => ({ session_id: 's1', result: 'ok' }),
    },
    recentDirectories: { add: () => {}, list: () => [] },
    backlogStore: { list: () => [] },
    memoryStore: { getCommon: () => ({ text: '' }), getProject: () => ({ text: '' }) },
    folderPicker: { pickFolder: async () => null },
    ...overrides,
  };
}

test('GET /api/sessions merges isRunning from claudeCli', async () => {
  const deps = makeDeps({ claudeCli: { isRunning: () => true, startSession: async () => ({}), sendMessage: async () => ({}) } });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'GET', '/api/sessions');
  assert.strictEqual(status, 200);
  assert.strictEqual(body[0].id, 's1');
  assert.strictEqual(body[0].isRunning, true);
  server.close();
});

test('POST /api/sessions requires cwd and message', async () => {
  const server = createApp(makeDeps()).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'POST', '/api/sessions', {});
  assert.strictEqual(status, 400);
  assert.ok(body.error);
  server.close();
});

test('POST /api/sessions starts a session and records the recent directory', async () => {
  const added = [];
  const deps = makeDeps({ recentDirectories: { add: (d) => added.push(d), list: () => [] } });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'POST', '/api/sessions', { cwd: 'D:\\demo', message: 'go' });
  assert.strictEqual(status, 201);
  assert.strictEqual(body.session_id, 'new-1');
  assert.deepStrictEqual(added, ['D:\\demo']);
  server.close();
});

test('POST /api/sessions/:id/message 404s for an unknown session', async () => {
  const server = createApp(makeDeps()).listen(0);
  const { port } = server.address();
  const { status } = await request(port, 'POST', '/api/sessions/unknown/message', { message: 'go' });
  assert.strictEqual(status, 404);
  server.close();
});

test('POST /api/sessions/:id/message resumes a known session', async () => {
  const server = createApp(makeDeps()).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'POST', '/api/sessions/s1/message', { message: 'go' });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.session_id, 's1');
  server.close();
});

test('GET /api/projects returns the project list', async () => {
  const server = createApp(makeDeps()).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'GET', '/api/projects');
  assert.strictEqual(status, 200);
  assert.strictEqual(body[0].projectFolder, 'D--demo');
  server.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL with "Cannot find module '../server/routes/sessions'" (or route 404s).

- [ ] **Step 3: Write `server/routes/sessions.js`**

```javascript
// server/routes/sessions.js
const express = require('express');

function createSessionsRouter({ sessionStore, claudeCli, recentDirectories }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const sessions = sessionStore.listSessions().map((s) => ({
      ...s,
      isRunning: claudeCli.isRunning(s.id),
    }));
    res.json(sessions);
  });

  router.post('/', async (req, res) => {
    const { cwd, message } = req.body;
    if (!cwd || !message) {
      res.status(400).json({ error: 'cwd and message are required' });
      return;
    }
    try {
      const result = await claudeCli.startSession(cwd, message);
      recentDirectories.add(cwd);
      res.status(201).json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  router.post('/:id/message', async (req, res) => {
    const { message } = req.body;
    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }
    const session = sessionStore.listSessions().find((s) => s.id === req.params.id);
    if (!session) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    try {
      const result = await claudeCli.sendMessage(req.params.id, session.projectPath, message);
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createSessionsRouter };
```

- [ ] **Step 4: Write `server/routes/projects.js`**

```javascript
// server/routes/projects.js
const express = require('express');

function createProjectsRouter({ sessionStore }) {
  const router = express.Router();
  router.get('/', (req, res) => {
    res.json(sessionStore.listProjects());
  });
  return router;
}

module.exports = { createProjectsRouter };
```

- [ ] **Step 5: Modify `server/app.js` to register both routers**

```javascript
// server/app.js
const express = require('express');
const path = require('path');
const { createSessionsRouter } = require('./routes/sessions');
const { createProjectsRouter } = require('./routes/projects');

function createApp(deps = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/health', (req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/sessions', createSessionsRouter(deps));
  app.use('/api/projects', createProjectsRouter(deps));

  return app;
}

module.exports = { createApp };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all `routes.sessions` tests green, plus all earlier tests still passing.

- [ ] **Step 7: Commit**

```bash
git add server/routes/sessions.js server/routes/projects.js server/app.js test/routes.sessions.test.js
git commit -m "Add sessions and projects API routes"
```

---

### Task 7: Backlog store and API routes

**Files:**
- Create: `server/lib/backlogStore.js`
- Create: `server/routes/backlog.js`
- Modify: `server/app.js` (register backlog router)
- Test: `test/backlogStore.test.js`
- Test: `test/routes.backlog.test.js`

**Interfaces:**
- Consumes: `readJson`/`writeJson` from `server/lib/jsonStore.js` (Task 3).
- Produces: `createBacklogStore({ filePath }): { list(), add({title, repoPath, priority}), update(id, changes), remove(id) }`. Item shape: `{ id, title, repoPath, priority, done, createdAt }`.
- Produces routes: `GET /api/backlog`, `POST /api/backlog`, `PATCH /api/backlog/:id`, `DELETE /api/backlog/:id`.

- [ ] **Step 1: Write the failing store test**

```javascript
// test/backlogStore.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBacklogStore } = require('../server/lib/backlogStore');

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-')), 'backlog.json');
}

test('list starts empty', () => {
  const store = createBacklogStore({ filePath: tempFile() });
  assert.deepStrictEqual(store.list(), []);
});

test('add creates an item with defaults and persists it', () => {
  const store = createBacklogStore({ filePath: tempFile() });
  const item = store.add({ title: 'Fix bug', repoPath: 'D:/demo' });
  assert.strictEqual(item.title, 'Fix bug');
  assert.strictEqual(item.priority, 'medium');
  assert.strictEqual(item.done, false);
  assert.strictEqual(store.list().length, 1);
});

test('update changes fields and returns the updated item', () => {
  const store = createBacklogStore({ filePath: tempFile() });
  const item = store.add({ title: 'Fix bug', repoPath: 'D:/demo' });
  const updated = store.update(item.id, { done: true });
  assert.strictEqual(updated.done, true);
  assert.strictEqual(store.list()[0].done, true);
});

test('update returns null for an unknown id', () => {
  const store = createBacklogStore({ filePath: tempFile() });
  assert.strictEqual(store.update('missing', { done: true }), null);
});

test('remove deletes the item', () => {
  const store = createBacklogStore({ filePath: tempFile() });
  const item = store.add({ title: 'Fix bug', repoPath: 'D:/demo' });
  store.remove(item.id);
  assert.deepStrictEqual(store.list(), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module '../server/lib/backlogStore'"

- [ ] **Step 3: Write `server/lib/backlogStore.js`**

```javascript
// server/lib/backlogStore.js
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
```

- [ ] **Step 4: Run store test to verify it passes**

Run: `npm test`
Expected: PASS — all 5 `backlogStore` tests green.

- [ ] **Step 5: Write the failing route test**

```javascript
// test/routes.backlog.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createApp } = require('../server/app');

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: 'localhost', port, path: urlPath, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }));
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function makeDeps(backlogStore) {
  return {
    sessionStore: { listSessions: () => [], listProjects: () => [] },
    claudeCli: { isRunning: () => false, startSession: async () => ({}), sendMessage: async () => ({}) },
    recentDirectories: { add: () => {}, list: () => [] },
    backlogStore,
    memoryStore: { getCommon: () => ({ text: '' }), getProject: () => ({ text: '' }) },
    folderPicker: { pickFolder: async () => null },
  };
}

test('POST /api/backlog requires title and repoPath', async () => {
  const server = createApp(makeDeps({ list: () => [], add: () => {} })).listen(0);
  const { port } = server.address();
  const { status } = await request(port, 'POST', '/api/backlog', {});
  assert.strictEqual(status, 400);
  server.close();
});

test('POST /api/backlog then GET /api/backlog round-trips', async () => {
  const items = [];
  const backlogStore = {
    list: () => items,
    add: ({ title, repoPath, priority }) => {
      const item = { id: '1', title, repoPath, priority: priority || 'medium', done: false };
      items.push(item);
      return item;
    },
  };
  const server = createApp(makeDeps(backlogStore)).listen(0);
  const { port } = server.address();
  const created = await request(port, 'POST', '/api/backlog', { title: 'Fix bug', repoPath: 'D:/demo' });
  assert.strictEqual(created.status, 201);
  const listed = await request(port, 'GET', '/api/backlog');
  assert.strictEqual(listed.body.length, 1);
  server.close();
});

test('PATCH /api/backlog/:id 404s for an unknown id', async () => {
  const backlogStore = { list: () => [], add: () => {}, update: () => null };
  const server = createApp(makeDeps(backlogStore)).listen(0);
  const { port } = server.address();
  const { status } = await request(port, 'PATCH', '/api/backlog/missing', { done: true });
  assert.strictEqual(status, 404);
  server.close();
});

test('DELETE /api/backlog/:id returns 204', async () => {
  const backlogStore = { list: () => [], add: () => {}, remove: () => {} };
  const server = createApp(makeDeps(backlogStore)).listen(0);
  const { port } = server.address();
  const { status } = await request(port, 'DELETE', '/api/backlog/1');
  assert.strictEqual(status, 204);
  server.close();
});
```

- [ ] **Step 6: Run route test to verify it fails**

Run: `npm test`
Expected: FAIL — `/api/backlog` 404s (no route registered yet).

- [ ] **Step 7: Write `server/routes/backlog.js`**

```javascript
// server/routes/backlog.js
const express = require('express');

function createBacklogRouter({ backlogStore }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json(backlogStore.list());
  });

  router.post('/', (req, res) => {
    const { title, repoPath, priority } = req.body;
    if (!title || !repoPath) {
      res.status(400).json({ error: 'title and repoPath are required' });
      return;
    }
    res.status(201).json(backlogStore.add({ title, repoPath, priority }));
  });

  router.patch('/:id', (req, res) => {
    const updated = backlogStore.update(req.params.id, req.body);
    if (!updated) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(updated);
  });

  router.delete('/:id', (req, res) => {
    backlogStore.remove(req.params.id);
    res.status(204).end();
  });

  return router;
}

module.exports = { createBacklogRouter };
```

- [ ] **Step 8: Modify `server/app.js` to register the backlog router**

```javascript
// server/app.js — add near the other route registrations
const { createBacklogRouter } = require('./routes/backlog');
// ...
app.use('/api/backlog', createBacklogRouter(deps));
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all `backlogStore` and `routes.backlog` tests green, plus everything from earlier tasks.

- [ ] **Step 10: Commit**

```bash
git add server/lib/backlogStore.js server/routes/backlog.js server/app.js test/backlogStore.test.js test/routes.backlog.test.js
git commit -m "Add backlog store and API routes"
```

---

### Task 8: Memory store (common + per-project) and API routes

**Files:**
- Create: `server/lib/memoryStore.js`
- Create: `server/routes/memory.js`
- Modify: `server/app.js` (register memory router)
- Test: `test/memoryStore.test.js`
- Test: `test/routes.memory.test.js`

**Interfaces:**
- Consumes: `readJson`/`writeJson` (Task 3), `encodeProjectPath` (Task 2).
- Produces: `createMemoryStore({ commonFilePath, projectDir }): { getCommon(), setCommon(text), getProject(projectPath), setProject(projectPath, text) }`. Each getter returns `{ text: string }`.
- Produces routes: `GET/PUT /api/memory/common`, `GET/PUT /api/memory/project?path=<projectPath>`.

- [ ] **Step 1: Write the failing store test**

```javascript
// test/memoryStore.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemoryStore } = require('../server/lib/memoryStore');

function makeStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-'));
  return createMemoryStore({
    commonFilePath: path.join(root, 'memory-common.json'),
    projectDir: path.join(root, 'memory-projects'),
  });
}

test('getCommon defaults to empty text', () => {
  assert.deepStrictEqual(makeStore().getCommon(), { text: '' });
});

test('setCommon then getCommon round-trips', () => {
  const store = makeStore();
  store.setCommon('shared context');
  assert.deepStrictEqual(store.getCommon(), { text: 'shared context' });
});

test('getProject defaults to empty text for an unseen project', () => {
  const store = makeStore();
  assert.deepStrictEqual(store.getProject('D:/Projects/demo'), { text: '' });
});

test('setProject then getProject round-trips, scoped per path', () => {
  const store = makeStore();
  store.setProject('D:/Projects/demo', 'notes for demo');
  store.setProject('D:/Projects/other', 'notes for other');
  assert.deepStrictEqual(store.getProject('D:/Projects/demo'), { text: 'notes for demo' });
  assert.deepStrictEqual(store.getProject('D:/Projects/other'), { text: 'notes for other' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module '../server/lib/memoryStore'"

- [ ] **Step 3: Write `server/lib/memoryStore.js`**

```javascript
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
```

- [ ] **Step 4: Run store test to verify it passes**

Run: `npm test`
Expected: PASS — all 4 `memoryStore` tests green.

- [ ] **Step 5: Write the failing route test**

```javascript
// test/routes.memory.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createApp } = require('../server/app');

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: 'localhost', port, path: urlPath, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }));
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function makeDeps(memoryStore) {
  return {
    sessionStore: { listSessions: () => [], listProjects: () => [] },
    claudeCli: { isRunning: () => false, startSession: async () => ({}), sendMessage: async () => ({}) },
    recentDirectories: { add: () => {}, list: () => [] },
    backlogStore: { list: () => [] },
    memoryStore,
    folderPicker: { pickFolder: async () => null },
  };
}

test('GET then PUT /api/memory/common round-trips', async () => {
  let stored = { text: '' };
  const memoryStore = {
    getCommon: () => stored,
    setCommon: (text) => { stored = { text }; return stored; },
    getProject: () => ({ text: '' }),
    setProject: () => ({ text: '' }),
  };
  const server = createApp(makeDeps(memoryStore)).listen(0);
  const { port } = server.address();
  await request(port, 'PUT', '/api/memory/common', { text: 'shared notes' });
  const { body } = await request(port, 'GET', '/api/memory/common');
  assert.deepStrictEqual(body, { text: 'shared notes' });
  server.close();
});

test('GET /api/memory/project requires a path query param', async () => {
  const memoryStore = { getCommon: () => ({ text: '' }), setCommon: () => ({}), getProject: () => ({ text: '' }), setProject: () => ({}) };
  const server = createApp(makeDeps(memoryStore)).listen(0);
  const { port } = server.address();
  const { status } = await request(port, 'GET', '/api/memory/project');
  assert.strictEqual(status, 400);
  server.close();
});

test('PUT then GET /api/memory/project round-trips for a given path', async () => {
  const perProject = new Map();
  const memoryStore = {
    getCommon: () => ({ text: '' }),
    setCommon: () => ({}),
    getProject: (p) => perProject.get(p) || { text: '' },
    setProject: (p, text) => { const v = { text }; perProject.set(p, v); return v; },
  };
  const server = createApp(makeDeps(memoryStore)).listen(0);
  const { port } = server.address();
  await request(port, 'PUT', '/api/memory/project', { path: 'D:/demo', text: 'per-project notes' });
  const { body } = await request(port, 'GET', '/api/memory/project?path=D:/demo');
  assert.deepStrictEqual(body, { text: 'per-project notes' });
  server.close();
});
```

- [ ] **Step 6: Run route test to verify it fails**

Run: `npm test`
Expected: FAIL — `/api/memory/common` 404s (no route registered yet).

- [ ] **Step 7: Write `server/routes/memory.js`**

```javascript
// server/routes/memory.js
const express = require('express');

function createMemoryRouter({ memoryStore }) {
  const router = express.Router();

  router.get('/common', (req, res) => {
    res.json(memoryStore.getCommon());
  });

  router.put('/common', (req, res) => {
    res.json(memoryStore.setCommon(req.body.text || ''));
  });

  router.get('/project', (req, res) => {
    const { path: projectPath } = req.query;
    if (!projectPath) {
      res.status(400).json({ error: 'path query param is required' });
      return;
    }
    res.json(memoryStore.getProject(projectPath));
  });

  router.put('/project', (req, res) => {
    const { path: projectPath, text } = req.body;
    if (!projectPath) {
      res.status(400).json({ error: 'path is required' });
      return;
    }
    res.json(memoryStore.setProject(projectPath, text || ''));
  });

  return router;
}

module.exports = { createMemoryRouter };
```

- [ ] **Step 8: Modify `server/app.js` to register the memory router**

```javascript
// server/app.js — add near the other route registrations
const { createMemoryRouter } = require('./routes/memory');
// ...
app.use('/api/memory', createMemoryRouter(deps));
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all `memoryStore` and `routes.memory` tests green, plus everything from earlier tasks.

- [ ] **Step 10: Commit**

```bash
git add server/lib/memoryStore.js server/routes/memory.js server/app.js test/memoryStore.test.js test/routes.memory.test.js
git commit -m "Add memory store (common + per-project) and API routes"
```

---

### Task 9: Recent directories + folder picker + directories API routes

**Files:**
- Create: `server/lib/recentDirectories.js`
- Create: `server/lib/folderPicker.js`
- Create: `server/routes/directories.js`
- Modify: `server/app.js` (register directories router)
- Modify: `server/routes/sessions.js` (already consumes `recentDirectories` — no change needed, just confirms the interface Task 6 already used)
- Test: `test/recentDirectories.test.js`
- Test: `test/folderPicker.test.js`
- Test: `test/routes.directories.test.js`

**Interfaces:**
- Produces: `createRecentDirectories({ filePath }): { list(), add(dirPath) }` — `add` de-duplicates case-insensitively, moves the entry to the front, and caps the list at 10.
- Produces: `pickFolder({ spawnFn }): Promise<string|null>` — spawns PowerShell's `FolderBrowserDialog`; returns `null` if the user cancels.
- Produces routes: `GET /api/directories/recent`, `POST /api/directories/browse`.

- [ ] **Step 1: Write the failing `recentDirectories` test**

```javascript
// test/recentDirectories.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRecentDirectories } = require('../server/lib/recentDirectories');

function tempFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recentdirs-')), 'recent.json');
}

test('list starts empty', () => {
  const store = createRecentDirectories({ filePath: tempFile() });
  assert.deepStrictEqual(store.list(), []);
});

test('add puts the newest directory first', () => {
  const store = createRecentDirectories({ filePath: tempFile() });
  store.add('D:\\a');
  store.add('D:\\b');
  assert.deepStrictEqual(store.list(), ['D:\\b', 'D:\\a']);
});

test('add de-duplicates case-insensitively and moves to front', () => {
  const store = createRecentDirectories({ filePath: tempFile() });
  store.add('D:\\a');
  store.add('D:\\b');
  store.add('d:\\A');
  assert.deepStrictEqual(store.list(), ['d:\\A', 'D:\\b']);
});

test('add caps the list at 10 entries', () => {
  const store = createRecentDirectories({ filePath: tempFile() });
  for (let i = 0; i < 12; i++) store.add(`D:\\dir${i}`);
  assert.strictEqual(store.list().length, 10);
  assert.strictEqual(store.list()[0], 'D:\\dir11');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module '../server/lib/recentDirectories'"

- [ ] **Step 3: Write `server/lib/recentDirectories.js`**

```javascript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all 4 `recentDirectories` tests green.

- [ ] **Step 5: Write the failing `folderPicker` test**

```javascript
// test/folderPicker.test.js
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { pickFolder } = require('../server/lib/folderPicker');

function fakeSpawn(stdout, exitCode = 0) {
  const calls = [];
  const spawnFn = (bin, args) => {
    calls.push({ bin, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', exitCode);
    });
    return child;
  };
  spawnFn.calls = calls;
  return spawnFn;
}

test('resolves the trimmed path printed by the picker script', async () => {
  const spawnFn = fakeSpawn('D:\\Projects\\demo\r\n');
  const result = await pickFolder({ spawnFn });
  assert.strictEqual(result, 'D:\\Projects\\demo');
  assert.strictEqual(spawnFn.calls[0].bin, 'powershell.exe');
});

test('resolves null when the dialog prints nothing (user cancelled)', async () => {
  const spawnFn = fakeSpawn('');
  const result = await pickFolder({ spawnFn });
  assert.strictEqual(result, null);
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module '../server/lib/folderPicker'"

- [ ] **Step 7: Write `server/lib/folderPicker.js`**

```javascript
// server/lib/folderPicker.js
const { spawn } = require('child_process');

const PICKER_SCRIPT = "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }";

function pickFolder({ spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn('powershell.exe', ['-NoProfile', '-STA', '-Command', PICKER_SCRIPT]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && stderr.trim()) {
        reject(new Error(stderr.trim()));
        return;
      }
      const trimmed = stdout.trim();
      resolve(trimmed.length > 0 ? trimmed : null);
    });
  });
}

module.exports = { pickFolder };
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npm test`
Expected: PASS — both `folderPicker` tests green.

- [ ] **Step 9: Write `server/routes/directories.js`**

```javascript
// server/routes/directories.js
const express = require('express');

function createDirectoriesRouter({ recentDirectories, folderPicker }) {
  const router = express.Router();

  router.get('/recent', (req, res) => {
    res.json(recentDirectories.list());
  });

  router.post('/browse', async (req, res) => {
    try {
      const selected = await folderPicker.pickFolder();
      res.json({ path: selected });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createDirectoriesRouter };
```

- [ ] **Step 10: Write the failing route test**

```javascript
// test/routes.directories.test.js
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

function makeDeps({ recentDirectories, folderPicker }) {
  return {
    sessionStore: { listSessions: () => [], listProjects: () => [] },
    claudeCli: { isRunning: () => false, startSession: async () => ({}), sendMessage: async () => ({}) },
    recentDirectories,
    backlogStore: { list: () => [] },
    memoryStore: { getCommon: () => ({ text: '' }), getProject: () => ({ text: '' }) },
    folderPicker,
  };
}

test('GET /api/directories/recent returns the list', async () => {
  const deps = makeDeps({ recentDirectories: { list: () => ['D:\\a'], add: () => {} }, folderPicker: { pickFolder: async () => null } });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'GET', '/api/directories/recent');
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body, ['D:\\a']);
  server.close();
});

test('POST /api/directories/browse returns the picked path', async () => {
  const deps = makeDeps({ recentDirectories: { list: () => [], add: () => {} }, folderPicker: { pickFolder: async () => 'D:\\chosen' } });
  const server = createApp(deps).listen(0);
  const { port } = server.address();
  const { status, body } = await request(port, 'POST', '/api/directories/browse');
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body, { path: 'D:\\chosen' });
  server.close();
});
```

- [ ] **Step 11: Modify `server/app.js` to register the directories router**

```javascript
// server/app.js — add near the other route registrations
const { createDirectoriesRouter } = require('./routes/directories');
// ...
app.use('/api/directories', createDirectoriesRouter(deps));
```

- [ ] **Step 12: Run all tests to verify they pass**

Run: `npm test`
Expected: PASS — all `routes.directories` tests green, plus everything from earlier tasks.

- [ ] **Step 13: Commit**

```bash
git add server/lib/recentDirectories.js server/lib/folderPicker.js server/routes/directories.js server/app.js test/recentDirectories.test.js test/folderPicker.test.js test/routes.directories.test.js
git commit -m "Add recent directories, native folder picker, and directories API"
```

---

### Task 10: Wire real dependencies + WebSocket status broadcast in `server/index.js`

**Files:**
- Modify: `server/index.js`

**Interfaces:**
- Consumes: `createSessionStore`, `createClaudeCli`, `createBacklogStore`, `createMemoryStore`, `createRecentDirectories`, `pickFolder`, `createApp` — all produced in Tasks 4–9.
- Produces: a running server that upgrades HTTP connections to WebSocket at the same port, and broadcasts `{ type: 'session-status', sessionId, status }` whenever `claudeCli`'s `onStatusChange` fires. This is what Task 12's frontend subscribes to.

This task has no new unit-testable logic (it's wiring), so it is verified manually instead of with `node:test`.

- [ ] **Step 1: Install the `ws` dependency (if not already present from Task 1's package.json)**

Run: `npm install`
Expected: `ws` present in `node_modules/`.

- [ ] **Step 2: Rewrite `server/index.js`**

```javascript
// server/index.js
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const { createApp } = require('./app');
const { createSessionStore } = require('./lib/sessionStore');
const { createClaudeCli } = require('./lib/claudeCli');
const { createBacklogStore } = require('./lib/backlogStore');
const { createMemoryStore } = require('./lib/memoryStore');
const { createRecentDirectories } = require('./lib/recentDirectories');
const { pickFolder } = require('./lib/folderPicker');

const PORT = process.env.PORT || 4317;
const dataDir = path.join(__dirname, '..', 'data');

const wss = new WebSocketServer({ noServer: true });

function broadcast(message) {
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

const sessionStore = createSessionStore();
const claudeCli = createClaudeCli({
  onStatusChange: (sessionId, status) => broadcast({ type: 'session-status', sessionId, status }),
});
const backlogStore = createBacklogStore({ filePath: path.join(dataDir, 'backlog.json') });
const memoryStore = createMemoryStore({
  commonFilePath: path.join(dataDir, 'memory-common.json'),
  projectDir: path.join(dataDir, 'memory-projects'),
});
const recentDirectories = createRecentDirectories({ filePath: path.join(dataDir, 'recent-directories.json') });
const folderPicker = { pickFolder };

const app = createApp({ sessionStore, claudeCli, backlogStore, memoryStore, recentDirectories, folderPicker });
const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

server.listen(PORT, () => {
  console.log(`Claude Code Dashboard running at http://localhost:${PORT}`);
});
```

- [ ] **Step 3: Verify the full test suite still passes**

Run: `npm test`
Expected: PASS — every test from Tasks 1–9 still green (this task didn't touch any tested module).

- [ ] **Step 4: Manually verify the server boots against real data**

Run: `npm start`, then in another terminal: `curl http://localhost:4317/api/sessions`
Expected: a JSON array reflecting real sessions found under `~/.claude/projects` on this machine (non-empty, given the projects explored earlier this session). Stop the server with Ctrl+C.

- [ ] **Step 5: Commit**

```bash
git add server/index.js package.json package-lock.json
git commit -m "Wire real dependencies and WebSocket status broadcast into the server entry point"
```

---

### Task 11: Frontend shell — HTML structure, CSS tokens, theme toggle

**Files:**
- Create: `public/index.html`
- Create: `public/styles.css`
- Create: `public/format.js`
- Test: `test/format.test.js`

**Interfaces:**
- Produces: `formatRelativeTime(isoString, now = new Date()): string` in `public/format.js`, loaded both by the browser (`<script src="/format.js">`) and by Node tests (guarded `module.exports`).
- Produces: the static page shell — header, sidebar, main content area, detail drawer — styled per `design/dashboard-mockup-v2.html`'s token system, with `id` attributes on the containers Task 12 will populate (`#session-grid`, `#project-list`, `#backlog-list`, `#detail-drawer`, `#new-session-menu`, `#command-input`, `#memory-panel`).

This task is a visual/structural task, not a logic task — `format.js` is the one piece of pure logic, and it gets a real test. The HTML/CSS is verified by loading it in a browser (Step 5), matching this repo's rule that UI changes must be checked in a browser before being called done.

- [ ] **Step 1: Write the failing test for `formatRelativeTime`**

```javascript
// test/format.test.js
const test = require('node:test');
const assert = require('node:assert');
const { formatRelativeTime } = require('../public/format.js');

test('returns "just now" for timestamps under a minute old', () => {
  const now = new Date('2026-07-15T12:00:30.000Z');
  assert.strictEqual(formatRelativeTime('2026-07-15T12:00:00.000Z', now), 'just now');
});

test('returns minutes for timestamps under an hour old', () => {
  const now = new Date('2026-07-15T12:18:00.000Z');
  assert.strictEqual(formatRelativeTime('2026-07-15T12:00:00.000Z', now), '18m');
});

test('returns hours for timestamps under a day old', () => {
  const now = new Date('2026-07-15T15:00:00.000Z');
  assert.strictEqual(formatRelativeTime('2026-07-15T12:00:00.000Z', now), '3h');
});

test('returns days for timestamps a day or more old', () => {
  const now = new Date('2026-07-17T12:00:00.000Z');
  assert.strictEqual(formatRelativeTime('2026-07-15T12:00:00.000Z', now), '2d');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module '../public/format.js'"

- [ ] **Step 3: Write `public/format.js`**

```javascript
// public/format.js
function formatRelativeTime(isoString, now = new Date()) {
  const then = new Date(isoString);
  const diffMs = now.getTime() - then.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { formatRelativeTime };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all 4 `format` tests green.

- [ ] **Step 5: Write `public/styles.css`**

Port the full token system and component classes from `design/dashboard-mockup-v2.html`'s `<style>` block verbatim (the `:root` variables, `:root[data-theme="light"]`, the `@media (prefers-color-scheme: light)` block, `.dot-grid`, `.eyebrow`, `.dotnum`, `.mono`, `.row`, `.card`, `.pill`, `.btn`, `.ghost`, `.menu-item`, `.banner`, the `pulse-dot`/`blink-caret` keyframes, and the `prefers-reduced-motion` override) into this file as real CSS (not inline `style=` attributes this time — this file is the single source of styling for the real app). Restore deliberate motion beyond what the static mockup had: keep `pulse-dot` on the header's running-count indicator and on each running session card's status dot, keep `blink-caret` on the command bar's cursor glyph, and add one load-in transition — `.card { animation: card-in .18s ease-out; } @keyframes card-in { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }` — applied once per card on initial render (Task 12 adds the class via JS when it creates each card element, so re-renders don't replay the animation on every poll).

- [ ] **Step 6: Write `public/index.html`**

Build the page structure directly from `design/dashboard-mockup-v2.html`'s markup (header with logo/eyebrow/search/running-count/theme-toggle/new-session button, sidebar with "All sessions" + per-project rows, main area with command bar + "Running & recent sessions" grid + backlog section, right-hand detail drawer) but:
- Move all `style="..."` inline styles into `styles.css` classes (reuse the class names already defined there: `.card`, `.row`, `.pill`, etc., plus new layout classes like `.header`, `.sidebar`, `.main`, `.drawer` for the structural containers).
- Replace the mockup's hardcoded project rows and session cards with a single empty container each — `<div id="project-list"></div>`, `<div id="session-grid"></div>`, `<div id="backlog-list"></div>` — since Task 12's `app.js` renders these from real API data.
- Give the "+ New session" button's dropdown a real `<div id="new-session-menu">` with a `<div id="recent-directories-list"></div>` placeholder and the "Browse for a different directory…" item wired to an `id="browse-directory-btn"`.
- Give the command bar's input an `id="command-input"` and its send button `id="command-send-btn"`.
- Give the detail drawer a `id="detail-drawer"`, initially hidden (`style="display:none"` toggled by `app.js`).
- Add a memory panel behind a new sidebar entry "Memory" — `<div id="memory-panel" style="display:none">` containing a `<textarea id="memory-common-text">`, a project selector `<select id="memory-project-select">`, and `<textarea id="memory-project-text">`, each with its own "Save" button (`#memory-common-save`, `#memory-project-save`) — this is new relative to the mockup since the mockup didn't include a memory screen; keep it visually consistent (same card/eyebrow/button styling).
- Link `format.js` before `app.js`: `<script src="/format.js"></script><script src="/app.js"></script>`.
- Keep the theme-toggle script inline exactly as in the mockup (the `__toggleTheme` IIFE), since it must run before first paint to avoid a flash of the wrong theme.

- [ ] **Step 7: Verify visually in a browser**

Run: `npm start`, open `http://localhost:4317` in a browser.
Expected: page loads with the header, sidebar, empty session grid, empty backlog, and detail drawer hidden — matching the mockup's layout and both themes (toggle via the ◐ button, and via OS-level dark/light preference). No console errors (an empty grid is expected — `app.js` doesn't exist yet, so nothing fetches; that's fine for this task, which only proves the shell renders).

- [ ] **Step 8: Commit**

```bash
git add public/index.html public/styles.css public/format.js test/format.test.js
git commit -m "Add frontend shell: HTML structure, design tokens, theme toggle"
```

---

### Task 12: Frontend behavior — wire the shell to the real API and WebSocket

**Files:**
- Create: `public/app.js`

**Interfaces:**
- Consumes: every route from Tasks 6–9 (`/api/sessions`, `/api/projects`, `/api/backlog`, `/api/memory/*`, `/api/directories/*`) and the WebSocket endpoint from Task 10.
- Consumes: `formatRelativeTime` from `public/format.js` (Task 11), already loaded as a global by the time `app.js` runs.

This task is almost entirely DOM wiring and has no pure functions worth unit-testing beyond what Task 11 already covered — it's verified by manual browser testing per this repo's rule that UI changes get checked in a browser before being called done.

- [ ] **Step 1: Write `public/app.js`**

```javascript
// public/app.js
(function () {
  const state = { sessions: [], projects: [], backlog: [], activeDetailId: null };

  async function fetchJson(url, options) {
    const res = await fetch(url, options);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `${res.status} ${res.statusText}`);
    }
    return res.status === 204 ? null : res.json();
  }

  async function loadSessions() {
    state.sessions = await fetchJson('/api/sessions');
    renderSessions();
  }

  async function loadProjects() {
    state.projects = await fetchJson('/api/projects');
    renderProjects();
  }

  async function loadBacklog() {
    state.backlog = await fetchJson('/api/backlog');
    renderBacklog();
  }

  function statusOf(session) {
    return session.isRunning ? 'running' : 'idle';
  }

  function renderSessions() {
    const grid = document.getElementById('session-grid');
    grid.innerHTML = '';
    for (const session of state.sessions) {
      const card = document.createElement('div');
      card.className = 'card';
      card.dataset.sessionId = session.id;
      const status = statusOf(session);
      card.innerHTML = `
        <div class="card-top">
          <span class="status-dot status-${status}"></span>
          <span class="eyebrow status-label">${status === 'running' ? 'Running' : 'Idle'}</span>
          <span class="dotnum card-time">${formatRelativeTime(session.lastActivity)}</span>
        </div>
        <div class="card-title">${session.title || '(no summary yet)'}</div>
        <div class="card-meta mono">
          <span>${session.projectFolder}${session.gitBranch ? ' · ' + session.gitBranch : ''}</span>
        </div>
      `;
      card.addEventListener('click', () => openDetail(session.id));
      grid.appendChild(card);
    }
  }

  function renderProjects() {
    const list = document.getElementById('project-list');
    list.innerHTML = '';
    for (const project of state.projects) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <div class="project-name">${project.projectFolder}</div>
        <div class="mono project-path">${project.projectPath}</div>
        <div class="dotnum project-count">${project.sessionCount}</div>
      `;
      list.appendChild(row);
    }
  }

  function renderBacklog() {
    const list = document.getElementById('backlog-list');
    list.innerHTML = '';
    for (const item of state.backlog) {
      const row = document.createElement('div');
      row.className = 'row backlog-row';
      row.innerHTML = `
        <input type="checkbox" ${item.done ? 'checked' : ''} data-id="${item.id}" class="backlog-done" />
        <div class="backlog-title">${item.title}</div>
        <div class="dotnum backlog-priority">${item.priority}</div>
        <div class="mono backlog-repo">${item.repoPath}</div>
      `;
      row.querySelector('.backlog-done').addEventListener('change', (e) => toggleBacklogItem(item.id, e.target.checked));
      list.appendChild(row);
    }
  }

  async function toggleBacklogItem(id, done) {
    await fetchJson(`/api/backlog/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done }),
    });
    await loadBacklog();
  }

  async function addBacklogItem(title, repoPath) {
    await fetchJson('/api/backlog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, repoPath }),
    });
    await loadBacklog();
  }

  function openDetail(sessionId) {
    const session = state.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    state.activeDetailId = sessionId;
    const drawer = document.getElementById('detail-drawer');
    drawer.style.display = 'flex';
    drawer.querySelector('.detail-title').textContent = session.title || '(no summary yet)';
    drawer.querySelector('.detail-meta').textContent = `${session.projectFolder}${session.gitBranch ? ' · ' + session.gitBranch : ''}`;
  }

  async function sendDetailMessage(message) {
    if (!state.activeDetailId || !message.trim()) return;
    await fetchJson(`/api/sessions/${state.activeDetailId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    await loadSessions();
  }

  async function loadRecentDirectories() {
    const dirs = await fetchJson('/api/directories/recent');
    const list = document.getElementById('recent-directories-list');
    list.innerHTML = '';
    for (const dir of dirs) {
      const item = document.createElement('div');
      item.className = 'menu-item mono';
      item.textContent = dir;
      item.addEventListener('click', () => startNewSession(dir));
      list.appendChild(item);
    }
  }

  async function browseForDirectory() {
    const { path } = await fetchJson('/api/directories/browse', { method: 'POST' });
    if (path) await startNewSession(path);
  }

  async function startNewSession(cwd) {
    const input = document.getElementById('command-input');
    const message = input.value.trim();
    if (!message) return;
    await fetchJson('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, message }),
    });
    input.value = '';
    await Promise.all([loadSessions(), loadProjects(), loadRecentDirectories()]);
  }

  function connectWebSocket() {
    const ws = new WebSocket(`ws://${location.host}`);
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'session-status') {
        loadSessions();
      }
    });
    ws.addEventListener('close', () => {
      setTimeout(connectWebSocket, 3000);
    });
  }

  async function loadMemoryCommon() {
    const { text } = await fetchJson('/api/memory/common');
    document.getElementById('memory-common-text').value = text;
  }

  async function saveMemoryCommon() {
    const text = document.getElementById('memory-common-text').value;
    await fetchJson('/api/memory/common', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  }

  async function loadMemoryProject(projectPath) {
    if (!projectPath) return;
    const { text } = await fetchJson(`/api/memory/project?path=${encodeURIComponent(projectPath)}`);
    document.getElementById('memory-project-text').value = text;
  }

  async function saveMemoryProject() {
    const select = document.getElementById('memory-project-select');
    const text = document.getElementById('memory-project-text').value;
    if (!select.value) return;
    await fetchJson('/api/memory/project', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: select.value, text }),
    });
  }

  function populateMemoryProjectSelect() {
    const select = document.getElementById('memory-project-select');
    select.innerHTML = '<option value="">Select a project…</option>';
    for (const project of state.projects) {
      const option = document.createElement('option');
      option.value = project.projectPath;
      option.textContent = project.projectFolder;
      select.appendChild(option);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('browse-directory-btn').addEventListener('click', browseForDirectory);
    document.getElementById('command-send-btn').addEventListener('click', () => {
      const active = document.querySelector('#recent-directories-list .menu-item.active');
      startNewSession(active ? active.textContent : state.projects[0]?.projectPath);
    });
    document.getElementById('memory-common-save').addEventListener('click', saveMemoryCommon);
    document.getElementById('memory-project-save').addEventListener('click', saveMemoryProject);
    document.getElementById('memory-project-select').addEventListener('change', (e) => loadMemoryProject(e.target.value));

    const detailInput = document.querySelector('#detail-drawer .detail-send-input');
    const detailSendBtn = document.querySelector('#detail-drawer .detail-send-btn');
    detailSendBtn.addEventListener('click', () => {
      sendDetailMessage(detailInput.value);
      detailInput.value = '';
    });

    loadSessions();
    loadProjects().then(populateMemoryProjectSelect);
    loadBacklog();
    loadRecentDirectories();
    loadMemoryCommon();
    connectWebSocket();
  });
})();
```

- [ ] **Step 2: Run the full test suite to confirm nothing regressed**

Run: `npm test`
Expected: PASS — every test from Tasks 1–11 still green (`app.js` has no exported pure functions to test; it's covered by the manual browser pass below).

- [ ] **Step 3: Manual browser verification of the golden path**

Run: `npm start`, open `http://localhost:4317`.
1. Confirm the sidebar shows real projects and the session grid shows real sessions from `~/.claude/projects`, with correct relative "last activity" times.
2. Click "+ New session", pick a recent directory, type a message in the command bar, click Send — confirm a `POST /api/sessions` call succeeds (Network tab) and the grid refreshes.
3. Click "Browse for a different directory…" — confirm the native Windows folder picker opens, and picking a folder starts a session in it.
4. Click a session card — confirm the detail drawer opens with the right title/meta, type a follow-up message, send it — confirm `POST /api/sessions/:id/message` succeeds.
5. Add a backlog item tagged to a real repo path — confirm it appears in the list; check its checkbox — confirm it persists after a page reload.
6. Open the Memory panel, write common memory text, save, reload the page — confirm it persisted. Select a project, write per-project memory, save, reload — confirm it persisted and is scoped to that project only.
7. Toggle the theme via the ◐ button — confirm all colors switch correctly with no unstyled flashes. Reload the page — confirm the toggle survived (if not, note this as a known gap, since the mockup's toggle wasn't wired to `localStorage` — acceptable for v1, add a follow-up backlog item for it rather than scope-creeping this task).

Expected: all steps above work without console errors. Record any real bugs found and fix them before moving on — this is the "test the golden path in a browser" checkpoint this repo's conventions require for UI work.

- [ ] **Step 4: Commit**

```bash
git add public/app.js
git commit -m "Wire frontend to the real API and WebSocket status updates"
```

---

### Task 13: Push to a remote repository

**Files:** none — this task is git/GitHub operations only.

This is the one task in this plan that touches shared/external state (creating a repository, publishing code to it), so it requires the user's explicit go-ahead on the specifics before anything is pushed — not just "push to git" in the abstract, but which host, which visibility, and under which name.

- [ ] **Step 1: Ask the user for the remote's details before creating anything**

Ask (do not assume): which Git host (GitHub, unless they say otherwise), what repository name (default suggestion: `claude-dashboard`), and visibility (private, unless they say otherwise — this repo will contain a `design/` mockup and specs but never the `data/` directory, since it's gitignored).

- [ ] **Step 2: Create the remote repository**

No `gh` CLI is installed on this machine (confirmed during planning). Either:
- (a) the user creates an empty repository on GitHub themselves and pastes the URL back, or
- (b) if a GitHub MCP tool is available and the user prefers it, use it to create the repository — but only after they've confirmed the name/visibility in Step 1, since repository creation is a "publishing" action requiring explicit permission per this assistant's operating rules.

- [ ] **Step 3: Add the remote and push**

```bash
git remote add origin <url-from-step-2>
git push -u origin master
```

Expected: push succeeds; the repository on the host shows all commits from Tasks 1–12.

- [ ] **Step 4: Confirm with the user**

Report the final remote URL back to the user so they have it for reference.

---

## Self-Review Notes

- **Spec coverage:** Goal 1 (session visibility) → Tasks 4, 6, 11, 12. Goal 2 (new session via directory picker) → Tasks 6, 9, 12. Goal 3 (send commands) → Tasks 5, 6, 12. Goal 4 (last activity at a glance) → Task 4's `lastActivity`, rendered in Task 12. Goal 5 (backlog tagged per repo) → Tasks 7, 12. Goal 6 (common + per-project memory) → Tasks 8, 12. Goal 7 (visual style, both themes) → Task 11. Known Risk 1 (live status limits) → explicitly scoped in Task 5/10 (`isRunning` only reflects dashboard-spawned processes) and called out again in Task 12 Step 3. Known Risk 2 (never write `~/.claude.json`) → enforced by Task 4 only ever calling `readJson` on the registry, stated in Global Constraints. Known Risk 3 (per-project memory source) → resolved as dashboard-owned files (Task 8), matching the spec's documented fallback. Known Risk 4 (one-shot dispatch) → Task 5's `runOneShot`, explicitly the chosen v1 approach. Known Risk 5 (Windows file-lock friction) → avoided entirely by not doing any background file-watching in v1 (sessions are read on-demand per request, not watched).
- **Placeholder scan:** no TBD/TODO markers; every step has real, complete code.
- **Type consistency:** `sessionStore.listSessions()` item shape (`id, projectFolder, projectPath, pathResolved, gitBranch, title, lastActivity, sizeBytes`) is defined once in Task 4 and used identically in Tasks 6, 10, 12. `claudeCli`'s `startSession(cwd, message)` / `sendMessage(sessionId, cwd, message)` signatures are defined in Task 5 and consumed identically in Task 6. `backlogStore` item shape (`id, title, repoPath, priority, done, createdAt`) is defined in Task 7 and consumed identically in Task 12. `memoryStore` getters all return `{ text }` consistently across Tasks 8 and 12.
