// server/routes/commands.js
const express = require('express');

function createCommandsRouter({ slashCommands }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const projectPath = req.query.path;
    if (!projectPath) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }
    res.json({ commands: slashCommands.listSlashCommands(projectPath) });
  });

  return router;
}

module.exports = { createCommandsRouter };
