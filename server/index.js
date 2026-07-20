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
const { createSettingsStore } = require('./lib/settingsStore');
const { createTranscriptWatcher } = require('./lib/transcriptWatcher');
const { pickFolder } = require('./lib/folderPicker');
const { pickFile } = require('./lib/filePicker');
const { listSlashCommands } = require('./lib/slashCommands');
const { getClaudeUserDefaults } = require('./lib/claudeUserConfig');

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
const settingsStore = createSettingsStore({ filePath: path.join(dataDir, 'settings.json') });
const folderPicker = { pickFolder };
const filePicker = { pickFile };
const slashCommands = { listSlashCommands };
const claudeUserConfig = { getClaudeUserDefaults };

const app = createApp({ sessionStore, claudeCli, backlogStore, memoryStore, recentDirectories, settingsStore, folderPicker, filePicker, slashCommands, claudeUserConfig });
const server = http.createServer(app);

const transcriptWatcher = createTranscriptWatcher({
  getTranscriptPath: (sessionId) => sessionStore.getTranscriptPath(sessionId),
});
wss.on('connection', (ws) => transcriptWatcher.attach(ws));

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// SECURITY: this app has no auth and POST /api/sessions spawns the `claude`
// CLI in an arbitrary directory on request. Binding to 0.0.0.0 would expose
// that as remote code execution to anything on the local network. Per spec
// this is a single-user, single-machine tool — keep the bind on loopback
// only. Do not "fix" this to listen on all interfaces.
// Last line of defence. Without this, a single stray throw outside a request
// handler — an fs.watch 'error', a ws send during teardown — exits the process
// and every view starts failing to fetch with nothing on screen explaining why.
// Staying up is the right trade here specifically because this server holds
// almost no in-memory state: the stores are file-backed and read per request,
// so a survived exception does not leave behind a half-updated model. Both
// handlers log loudly rather than swallowing quietly.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] server stayed up, but this is a bug:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] server stayed up, but this is a bug:', reason);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Claude Code Dashboard running at http://127.0.0.1:${PORT} (local only)`);
});

// Agent runs are invoked with `--print` and block the HTTP request open for
// the full duration of the run, which can legitimately exceed Node's default
// 5-minute request/headers timeout. Disable both so a long-running agent
// isn't aborted mid-run while the child process keeps executing.
server.requestTimeout = 0;
server.headersTimeout = 0;

// The dashboard polls every 10s and the browser keeps sockets pooled between
// polls. Node's default keepAliveTimeout is 5s, so the server would close an
// idle socket right in the window where the next poll is about to reuse it —
// the browser writes onto a socket that is being torn down, the request never
// completes, and fetch() rejects with a bare "Failed to fetch". Holding idle
// sockets open longer than the poll interval closes that race.
server.keepAliveTimeout = 65 * 1000;
