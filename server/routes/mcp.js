// server/routes/mcp.js
const express = require('express');

function createMcpRouter({ mcpStatus }) {
  const router = express.Router();

  router.get('/status', async (req, res) => {
    const cwd = typeof req.query.cwd === 'string' ? req.query.cwd : '';
    if (!cwd) {
      res.status(400).json({ error: 'cwd is required' });
      return;
    }
    try {
      const result = await mcpStatus.listServers(cwd);
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createMcpRouter };
