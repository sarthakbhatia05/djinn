// server/routes/projects.js
const express = require('express');

function createProjectsRouter({ sessionStore }) {
  const router = express.Router();
  router.get('/', (req, res) => {
    res.json(sessionStore.listProjects());
  });
  return router;
}

module.exports = { createProjectsRouter };
