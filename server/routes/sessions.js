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

  // Registered before the '/:id/message' style param routes for clarity;
  // 'active-count' is a literal path segment so there's no real ambiguity,
  // but keep this above anything that could shadow it.
  router.get('/active-count', (req, res) => {
    res.json({ activeCount: claudeCli.getActiveCount() });
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
