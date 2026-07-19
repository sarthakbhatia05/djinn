// server/lib/settingsStore.js
const { readJson, writeJson } = require('./jsonStore');

const DEFAULTS = { assistantName: null, onboardedAt: null, projects: [] };

// Tracked-project paths are compared loosely because the same directory shows
// up with varying case and slash direction across ~/.claude.json, transcript
// folders, and user input (this mirrors sessionStore's case-insensitive
// registry matching).
function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function createSettingsStore({ filePath, now = () => new Date() }) {
  function get() {
    const stored = readJson(filePath, {});
    return { ...DEFAULTS, ...stored };
  }

  function update(patch) {
    const current = get();
    const next = { ...current };

    if (patch.assistantName !== undefined) {
      if (typeof patch.assistantName !== 'string' || !patch.assistantName.trim()) {
        throw new Error('assistantName must be a non-empty string');
      }
      next.assistantName = patch.assistantName.trim();
      if (!current.onboardedAt) next.onboardedAt = now().toISOString();
    }

    if (patch.projects !== undefined) {
      if (!Array.isArray(patch.projects) || patch.projects.some((p) => typeof p !== 'string' || !p.trim())) {
        throw new Error('projects must be an array of non-empty strings');
      }
      const seen = new Set();
      next.projects = patch.projects
        .map((p) => p.trim())
        .filter((p) => {
          const key = normalizePath(p);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    }

    writeJson(filePath, next);
    return next;
  }

  function isTracked(projectPath) {
    if (!projectPath) return false;
    const key = normalizePath(projectPath);
    return get().projects.some((p) => normalizePath(p) === key);
  }

  function addProject(projectPath) {
    if (isTracked(projectPath)) return get();
    return update({ projects: [...get().projects, projectPath] });
  }

  return { get, update, isTracked, addProject };
}

module.exports = { createSettingsStore, normalizePath };
