// server/routes/usage.js
const express = require('express');

function createUsageRouter({ usageStore }) {
  const router = express.Router();
  router.get('/', (req, res) => {
    res.json(usageStore.getAll());
  });
  return router;
}

module.exports = { createUsageRouter };
