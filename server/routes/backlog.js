const express = require('express');

function createBacklogRouter({ backlogStore }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json(backlogStore.list());
  });

  router.post('/', (req, res) => {
    const { title, repoPath, priority } = req.body;
    if (!title || !repoPath) {
      res.status(400).json({ error: 'title and repoPath are required' });
      return;
    }
    res.status(201).json(backlogStore.add({ title, repoPath, priority }));
  });

  router.patch('/:id', (req, res) => {
    const updated = backlogStore.update(req.params.id, req.body);
    if (!updated) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(updated);
  });

  router.delete('/:id', (req, res) => {
    backlogStore.remove(req.params.id);
    res.status(204).end();
  });

  return router;
}

module.exports = { createBacklogRouter };
