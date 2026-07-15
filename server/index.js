const path = require('path');
const http = require('http');
const { createApp } = require('./app');

const PORT = process.env.PORT || 4317;

const app = createApp({});
const server = http.createServer(app);

server.listen(PORT, () => {
  console.log(`Claude Code Dashboard running at http://localhost:${PORT}`);
});
