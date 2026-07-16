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
