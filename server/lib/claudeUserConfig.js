// server/lib/claudeUserConfig.js
//
// Read-only lookup of the user's actual configured defaults from
// ~/.claude/settings.json — purely for display (e.g. "Default (Sonnet)" in
// the model/permission-mode dropdowns), so "Default" isn't a mystery. Never
// writes to this file; Claude Code owns it.
const os = require('os');
const path = require('path');
const { readJson } = require('./jsonStore');

function getClaudeUserDefaults({ settingsPath = path.join(os.homedir(), '.claude', 'settings.json') } = {}) {
  // Same reasoning as sessionStore's ~/.claude.json read: this file is
  // written live by the CLI, so a mid-write read can yield malformed JSON.
  // readJson only falls back on ENOENT, so treat any other read/parse
  // failure as "nothing configured" rather than a 500.
  let settings;
  try {
    settings = readJson(settingsPath, {});
  } catch {
    settings = {};
  }
  const model = typeof settings.model === 'string' && settings.model.trim() ? settings.model.trim() : null;
  const permissionMode =
    settings.permissions && typeof settings.permissions.defaultMode === 'string' && settings.permissions.defaultMode.trim()
      ? settings.permissions.defaultMode.trim()
      : null;
  return { model, permissionMode };
}

module.exports = { getClaudeUserDefaults };
