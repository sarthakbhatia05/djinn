const express = require('express');
const path = require('path');
const { createSessionsRouter } = require('./routes/sessions');
const { createProjectsRouter } = require('./routes/projects');
const { createBacklogRouter } = require('./routes/backlog');
const { createMemoryRouter } = require('./routes/memory');

function createApp(deps = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/health', (req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/sessions', createSessionsRouter(deps));
  app.use('/api/projects', createProjectsRouter(deps));
  app.use('/api/backlog', createBacklogRouter(deps));
  app.use('/api/memory', createMemoryRouter(deps));

  return app;
}

module.exports = { createApp };
