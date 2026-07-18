const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJson } = require('./jsonStore');
const { encodeProjectPath } = require('./pathEncoding');

const READ_HEAD_BYTES = 8192;

// Synthetic wrapper lines (slash-command scaffolding, hook output, etc.) are
// real type:'user' messages but make terrible titles. Skip anything whose
// content opens with one of these tags.
const WRAPPER_TAG_PREFIXES = [
  '<local-command-caveat',
  '<command-name',
  '<command-message',
  '<command-args',
  '<system-reminder',
  '<user-prompt-submit-hook',
];

const TITLE_MAX_LENGTH = 120;

function isWrapperContent(content) {
  const trimmed = content.trim();
  return WRAPPER_TAG_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function normalizeTitle(content) {
  const collapsed = content.trim().replace(/\s+/g, ' ');
  if (collapsed.length <= TITLE_MAX_LENGTH) return collapsed;
  return `${collapsed.slice(0, TITLE_MAX_LENGTH)}…`;
}

function readHead(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const size = Math.min(READ_HEAD_BYTES, stat.size);
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, 0);
    return buffer.toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

function parseHeadMeta(filePath) {
  const head = readHead(filePath);
  const lines = head.split('\n');
  let gitBranch = null;
  let title = null;

  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!gitBranch && obj.gitBranch) gitBranch = obj.gitBranch;
    if (!title && obj.type === 'user' && !obj.isMeta && typeof obj.message?.content === 'string') {
      const content = obj.message.content;
      if (!isWrapperContent(content)) {
        title = normalizeTitle(content);
      }
    }
    if (gitBranch && title) break;
  }

  return { gitBranch, title };
}

// Final path segment of a resolved project path, for use as a friendly
// display name. Handles both '\' and '/' separators and trailing separators.
// Falls back to the raw folder name when the path never resolved.
function deriveProjectName(projectPath, projectFolder) {
  if (!projectPath) return projectFolder;
  const trimmed = projectPath.replace(/[\\/]+$/, '');
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0) return projectPath || projectFolder;
  return segments[segments.length - 1];
}

function createSessionStore({
  claudeHomeDir = path.join(os.homedir(), '.claude', 'projects'),
  registryPath = path.join(os.homedir(), '.claude.json'),
} = {}) {
  function loadRegistryKeys() {
    // ~/.claude.json is written live by the Claude Code CLI; a mid-write /
    // truncated read yields malformed JSON. readJson only falls back on ENOENT,
    // so a SyntaxError would otherwise propagate and crash the store. Treat any
    // read/parse failure as an empty registry (sessions get pathResolved:false).
    try {
      const registry = readJson(registryPath, { projects: {} });
      return Object.keys(registry.projects || {});
    } catch {
      return [];
    }
  }

  function resolveProjectPath(projectFolder, registryKeys) {
    for (const key of registryKeys) {
      if (encodeProjectPath(key).toLowerCase() === projectFolder.toLowerCase()) {
        return key;
      }
    }
    return null;
  }

  function listSessions() {
    if (!fs.existsSync(claudeHomeDir)) return [];
    const registryKeys = loadRegistryKeys();
    const folders = fs.readdirSync(claudeHomeDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    const sessions = [];
    for (const projectFolder of folders) {
      const resolved = resolveProjectPath(projectFolder, registryKeys);
      const projectDir = path.join(claudeHomeDir, projectFolder);
      const files = fs.readdirSync(projectDir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith('.jsonl'));

      for (const file of files) {
        const filePath = path.join(projectDir, file.name);
        const stat = fs.statSync(filePath);
        const { gitBranch, title } = parseHeadMeta(filePath);
        const projectPath = resolved || projectFolder;
        sessions.push({
          id: file.name.replace(/\.jsonl$/, ''),
          projectFolder,
          projectPath,
          projectName: deriveProjectName(projectPath, projectFolder),
          pathResolved: resolved !== null,
          gitBranch,
          title,
          lastActivity: stat.mtime.toISOString(),
          sizeBytes: stat.size,
        });
      }
    }
    return sessions;
  }

  function listProjects() {
    const sessions = listSessions();
    const byPath = new Map();
    for (const s of sessions) {
      const existing = byPath.get(s.projectPath);
      if (!existing) {
        byPath.set(s.projectPath, {
          projectPath: s.projectPath,
          projectFolder: s.projectFolder,
          projectName: s.projectName,
          sessionCount: 1,
          lastActivity: s.lastActivity,
        });
      } else {
        existing.sessionCount += 1;
        if (s.lastActivity > existing.lastActivity) existing.lastActivity = s.lastActivity;
      }
    }
    return [...byPath.values()].sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1));
  }

  return { listSessions, listProjects };
}

module.exports = { createSessionStore };
