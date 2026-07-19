// server/routes/settings.js
const express = require('express');

function createSettingsRouter({ settingsStore }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json(settingsStore.get());
  });

  router.put('/', (req, res) => {
    const { assistantName, projects } = req.body || {};
    if (assistantName === undefined && projects === undefined) {
      res.status(400).json({ error: 'assistantName or projects is required' });
      return;
    }
    try {
      const updated = settingsStore.update({ assistantName, projects });
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createSettingsRouter };
