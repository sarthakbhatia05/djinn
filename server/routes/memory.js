// server/routes/memory.js
const express = require('express');

function createMemoryRouter({ memoryStore }) {
  const router = express.Router();

  router.get('/common', (req, res) => {
    res.json(memoryStore.getCommon());
  });

  router.put('/common', (req, res) => {
    res.json(memoryStore.setCommon(req.body.text || ''));
  });

  router.get('/project', (req, res) => {
    const { path: projectPath } = req.query;
    if (!projectPath) {
      res.status(400).json({ error: 'path query param is required' });
      return;
    }
    res.json(memoryStore.getProject(projectPath));
  });

  router.put('/project', (req, res) => {
    const { path: projectPath, text } = req.body;
    if (!projectPath) {
      res.status(400).json({ error: 'path is required' });
      return;
    }
    res.json(memoryStore.setProject(projectPath, text || ''));
  });

  return router;
}

module.exports = { createMemoryRouter };
