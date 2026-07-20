// server/routes/sessions.js
const express = require('express');
const { normalizePath } = require('../lib/settingsStore');
const { asyncHandler } = require('../lib/asyncHandler');

function createSessionsRouter({ sessionStore, claudeCli, recentDirectories, settingsStore, usageStore }) {
  const router = express.Router();

  // Persists the cost/token figures a claude CLI JSON result carries, if
  // any. `usageStore` is optional (some callers/tests don't inject it) and
  // a result can lack a session id (e.g. an error response) — in either
  // case this is a silent no-op rather than a throw. Missing cost/token
  // fields on the result itself are defaulted to 0 inside usageStore.
  function recordUsageFromResult(sessionId, result) {
    if (!usageStore || !sessionId) return;
    usageStore.recordUsage(sessionId, {
      costUsd: result && result.total_cost_usd,
      inputTokens: result && result.usage && result.usage.input_tokens,
      outputTokens: result && result.usage && result.usage.output_tokens,
    });
  }

  router.get('/', (req, res) => {
    let sessions = sessionStore.listSessions();
    // Tracked-projects allowlist: sessions outside settings.projects are
    // hidden, not deleted — nothing on disk changes, so untracking is always
    // reversible. An empty allowlist means an empty dashboard by design.
    if (settingsStore) {
      const tracked = new Set(settingsStore.get().projects.map(normalizePath));
      sessions = sessions.filter((s) => tracked.has(normalizePath(s.projectPath)));
    }
    res.json(sessions.map((s) => ({
      ...s,
      isRunning: claudeCli.isRunning(s.id),
    })));
  });

  // Registered before the '/:id/message' style param routes for clarity;
  // 'active-count' is a literal path segment so there's no real ambiguity,
  // but keep this above anything that could shadow it.
  router.get('/active-count', (req, res) => {
    res.json({ activeCount: claudeCli.getActiveCount() });
  });

  router.post('/', asyncHandler(async (req, res) => {
    const { cwd, message, model, permissionMode } = req.body;
    if (!cwd || !message) {
      res.status(400).json({ error: 'cwd and message are required' });
      return;
    }
    const result = await claudeCli.startSession(cwd, message, { model, permissionMode });
    recentDirectories.add(cwd);
    // Starting a session in an untracked directory implies the user wants
    // to see it — add it to the allowlist so it doesn't vanish from view.
    if (settingsStore) settingsStore.addProject(cwd);
    // A fresh session's real id isn't known until the CLI returns it.
    recordUsageFromResult(result && result.session_id, result);
    res.status(201).json(result);
  }));

  router.get('/:id/messages', (req, res) => {
    const messages = sessionStore.readMessages(req.params.id);
    if (messages === null) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    res.json({ messages });
  });

  router.post('/:id/message', asyncHandler(async (req, res) => {
    const { message, model, permissionMode } = req.body;
    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }
    const session = sessionStore.listSessions().find((s) => s.id === req.params.id);
    if (!session) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    // pathResolved:false means projectPath is the encoded folder name, not a
    // real directory — spawning with it as cwd fails with a raw ENOENT.
    if (session.pathResolved === false) {
      res.status(409).json({ error: 'this session\'s project directory could not be resolved; it may have been moved or removed' });
      return;
    }
    const result = await claudeCli.sendMessage(req.params.id, session.projectPath, message, { model, permissionMode });
    recordUsageFromResult((result && result.session_id) || req.params.id, result);
    res.json(result);
  }));

  // Kills the child process backing a running session (dashboard-spawned
  // sessions only — see claudeCli.cancel). Not found under this id means
  // there's nothing to cancel, not a server error, hence 404.
  router.post('/:id/cancel', (req, res) => {
    const cancelled = claudeCli.cancel(req.params.id);
    if (!cancelled) {
      res.status(404).json({ error: 'session not running' });
      return;
    }
    res.json({ cancelled: true });
  });

  return router;
}

module.exports = { createSessionsRouter };
