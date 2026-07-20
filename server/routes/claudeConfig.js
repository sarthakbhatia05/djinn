// server/routes/claudeConfig.js
const express = require('express');

function createClaudeConfigRouter({ claudeUserConfig }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json(claudeUserConfig.getClaudeUserDefaults());
  });

  return router;
}

module.exports = { createClaudeConfigRouter };
