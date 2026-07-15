const express = require('express');
const path = require('path');

function createApp(deps = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/health', (req, res) => {
    res.json({ ok: true });
  });

  return app;
}

module.exports = { createApp };
