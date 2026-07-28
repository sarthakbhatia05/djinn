// server/routes/sessions.js
const express = require('express');
const { normalizePath } = require('../lib/settingsStore');
const { asyncHandler } = require('../lib/asyncHandler');

// How long a session's transcript can sit on an unresolved tool_use before
// it's reported as needing input rather than just running. A single number
// has to cover both a routine slow tool (a big grep, a full test run) and a
// permission prompt the headless CLI can never actually get answered — so it
// errs toward the slow-tool side. 25s comfortably clears ordinary tool calls
// while still catching a genuine hang well before a user would give up and go
// check manually themselves.
const NEEDS_INPUT_STALE_MS = 25000;

function createSessionsRouter({ sessionStore, claudeCli, recentDirectories, settingsStore }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    let sessions = sessionStore.listSessions();
    // Tracked-projects allowlist: sessions outside settings.projects are
    // hidden, not deleted — nothing on disk changes, so untracking is always
    // reversible. An empty allowlist means an empty dashboard by design.
    if (settingsStore) {
      const tracked = new Set(settingsStore.get().projects.map(normalizePath));
      sessions = sessions.filter((s) => tracked.has(normalizePath(s.projectPath)));
    }
    res.json(sessions.map((s) => {
      const isRunning = claudeCli.isRunning(s.id);
      // Only worth the transcript tail-read for sessions actually running —
      // an idle session can't be "stuck" waiting on anything.
      let needsInput = false;
      if (isRunning) {
        const pendingSince = sessionStore.getPendingToolUseSince(s.id);
        needsInput = !!pendingSince && (Date.now() - Date.parse(pendingSince)) > NEEDS_INPUT_STALE_MS;
      }
      return { ...s, isRunning, needsInput };
    }));
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
