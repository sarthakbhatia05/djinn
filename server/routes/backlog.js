const express = require('express');

// Mass-assignment guard: PATCH must never let a client overwrite id/createdAt
// (or any other field we don't know about) by passing req.body straight
// through to the store. Only these fields are writable via this route.
const UPDATABLE_FIELDS = ['title', 'repoPath', 'priority', 'done'];

function pickUpdatableFields(body) {
  const changes = {};
  for (const key of UPDATABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      changes[key] = body[key];
    }
  }
  return changes;
}

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
    const changes = pickUpdatableFields(req.body || {});
    const updated = backlogStore.update(req.params.id, changes);
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
