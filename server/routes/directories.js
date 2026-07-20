// server/routes/directories.js
const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');

function createDirectoriesRouter({ recentDirectories, folderPicker, filePicker }) {
  const router = express.Router();

  router.get('/recent', (req, res) => {
    res.json(recentDirectories.list());
  });

  router.post('/browse', asyncHandler(async (req, res) => {
    const selected = await folderPicker.pickFolder();
    res.json({ path: selected });
  }));

  // Mirrors POST /browse above (same HTTP method, for consistency) but opens
  // a single-file picker instead of a folder picker.
  router.post('/browse-file', asyncHandler(async (req, res) => {
    const selected = await filePicker.pickFile();
    res.json({ path: selected });
  }));

  return router;
}

module.exports = { createDirectoriesRouter };
