// server/routes/directories.js
const express = require('express');

function createDirectoriesRouter({ recentDirectories, folderPicker, filePicker }) {
  const router = express.Router();

  router.get('/recent', (req, res) => {
    res.json(recentDirectories.list());
  });

  router.post('/browse', async (req, res) => {
    try {
      const selected = await folderPicker.pickFolder();
      res.json({ path: selected });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Mirrors POST /browse above (same HTTP method, for consistency) but opens
  // a single-file picker instead of a folder picker.
  router.post('/browse-file', async (req, res) => {
    try {
      const selected = await filePicker.pickFile();
      res.json({ path: selected });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createDirectoriesRouter };
