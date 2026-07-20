const express = require('express');
const path = require('path');
const { createSessionsRouter } = require('./routes/sessions');
const { createProjectsRouter } = require('./routes/projects');
const { createBacklogRouter } = require('./routes/backlog');
const { createMemoryRouter } = require('./routes/memory');
const { createDirectoriesRouter } = require('./routes/directories');
const { createSettingsRouter } = require('./routes/settings');
const { createCommandsRouter } = require('./routes/commands');
const { createClaudeConfigRouter } = require('./routes/claudeConfig');
const { createMcpRouter } = require('./routes/mcp');

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
  app.use('/api/directories', createDirectoriesRouter(deps));
  app.use('/api/settings', createSettingsRouter(deps));
  app.use('/api/commands', createCommandsRouter(deps));
  app.use('/api/claude-defaults', createClaudeConfigRouter(deps));
  app.use('/api/mcp', createMcpRouter(deps));

  // Centralized error handler. Any route that calls next(err) — or, for an
  // async handler, rejects via the asyncHandler wrapper — lands here instead
  // of falling through to Express's default HTML error page, which the
  // frontend's fetchJson can't parse. Keeps deliberate 4xx validation
  // responses (which routes send directly via res.status().json()) as-is;
  // this only covers thrown/rejected errors.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const status = typeof err.status === 'number' ? err.status : 500;
    // Never leak raw internal error messages (stack traces, file paths, etc.)
    // for unexpected 5xx failures — only pass through err.message when a
    // handler explicitly set a 4xx status on the error.
    const message = status < 500 && err.message ? err.message : 'Internal server error';
    res.status(status).json({ error: message });
  });

  return app;
}

module.exports = { createApp };
