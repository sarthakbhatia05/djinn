const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJson } = require('./jsonStore');
const { encodeProjectPath } = require('./pathEncoding');

// How far into a transcript we scan looking for the first real user prompt
// (used for the session title) and gitBranch. Measured across all 162 real
// transcripts on this machine: byte offset of the first real user prompt is
// p50=10.5KB, p75=16.2KB, p90=16.6KB, p95=17.8KB, p99=25.2KB, max=52.9KB.
// 8KB only resolved 12/162 titles; 64KB resolves 145/162 (the ceiling — the
// other 17 transcripts have no real user prompt at all). Budgets above 64KB
// (128KB/256KB/512KB) resolve no additional titles, so do not raise this
// further without new evidence.
const READ_HEAD_BYTES = 65536;

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

// How far from the end of a transcript to look when deciding whether a
// running session is stuck waiting on a tool the user needs to act on (a
// permission prompt in particular — dashboard-spawned sessions run headless,
// with no TTY attached to answer one, so a tool requiring approval under the
// CLI's own default permission mode hangs forever, not just slowly). 64KB
// matches READ_HEAD_BYTES: generous enough to comfortably hold the last few
// JSONL lines, including a sizeable tool result, without reading the whole
// file on every poll of a long session.
const TAIL_READ_BYTES = 65536;

function readTail(filePath, stat) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = Math.min(TAIL_READ_BYTES, stat.size);
    const start = stat.size - size;
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, start);
    const text = buffer.toString('utf-8');
    // Unlike readHead, a tail read can start mid-line. Drop the first line
    // whenever the read didn't begin at byte 0 of the file — it may be
    // partial, and a partial JSON line only ever fails to parse anyway, so
    // dropping it costs nothing but avoids treating a truncation artifact as
    // a real (if malformed) event.
    const lines = text.split('\n');
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    fs.closeSync(fd);
  }
}

// Returns the ISO timestamp the session started waiting on an unresolved tool
// call, or null if it isn't waiting on one (as far as the tail read shows).
// This is a heuristic, not a certainty: the same signal — the transcript's
// last event being an assistant message that ends in a tool_use with no
// tool_result after it — is also just what an ordinary in-flight tool call
// looks like while it's still running. The caller is expected to only treat
// this as "stuck" once it has held for a while; a merely slow tool clears it
// as soon as its result lands, same as in every ordinary run (confirmed
// against real transcripts: every tool_use in a completed session has exactly
// one matching tool_result).
function pendingToolUseSince(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const lines = readTail(filePath, stat);
    let last = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const content = obj.message && obj.message.content;
      if (obj.type === 'assistant' && Array.isArray(content)) last = obj;
      else if (obj.type === 'user' && Array.isArray(content)) last = obj;
    }
    if (!last || last.type !== 'assistant') return null; // resolved, or nothing to go on
    const blocks = last.message.content;
    const endsInToolUse = blocks.length > 0 && blocks[blocks.length - 1].type === 'tool_use';
    return endsInToolUse && typeof last.timestamp === 'string' ? last.timestamp : null;
  } catch {
    return null; // never let this take session listing down
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

// Module-level cache of head-parse results, keyed on absolute file path.
// listSessions() runs on every /api/sessions request (page load + every WS
// status push), and re-reading up to 64KB per transcript each time is
// wasteful once a session's early lines have stopped changing (which is true
// for the vast majority of the file's lifetime — only the tail grows as the
// conversation continues). Cache entries are invalidated by comparing the
// current stat's mtimeMs and size against the cached ones; a mismatch means
// the file changed and must be re-read. No TTL/eviction: one small object per
// transcript file is negligible at this scale, and the cache lives for the
// server process's lifetime. Keyed on absolute file path, so distinct store
// instances (e.g. different fixture dirs in tests) can never collide.
const headMetaCache = new Map();

function getHeadMeta(filePath, stat) {
  const cached = headMetaCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.meta;
  }
  const meta = parseHeadMeta(filePath);
  headMetaCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
  return meta;
}

// Tool-use blocks collapse to a one-line summary in the chat view. Prefer the
// human-readable description the model attached to the call; fall back to the
// most identifying input field.
const TOOL_SUMMARY_MAX_LENGTH = 120;

function summarizeToolUse(block) {
  const input = block.input || {};
  let detail = '';
  if (typeof input.description === 'string' && input.description.trim()) detail = input.description;
  else if (typeof input.command === 'string') detail = input.command;
  else if (typeof input.file_path === 'string') detail = input.file_path;
  else if (typeof input.pattern === 'string') detail = input.pattern;
  const text = detail ? `Ran ${block.name}: ${detail}` : `Ran ${block.name}`;
  const collapsed = text.trim().replace(/\s+/g, ' ');
  if (collapsed.length <= TOOL_SUMMARY_MAX_LENGTH) return collapsed;
  return `${collapsed.slice(0, TOOL_SUMMARY_MAX_LENGTH)}…`;
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
  // A second source of absolute project paths to resolve encoded folder names
  // against. ~/.claude.json is the CLI's own registry and lists only projects
  // the CLI itself knows about — a directory this dashboard started a session
  // in may never appear there. With the registry as the only source those
  // sessions resolve to nothing: they report pathResolved:false, get filtered
  // out of the tracked-projects view entirely, and can't be continued, even
  // though we were handed their real absolute path when the session was
  // created. Wired to the tracked-projects list in server/index.js.
  extraProjectPaths = () => [],
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

  // Registry first: those keys come from the CLI itself and are the more
  // authoritative spelling of a path. Tracked projects only fill the gaps.
  function candidateProjectPaths() {
    let extra;
    try {
      extra = extraProjectPaths() || [];
    } catch {
      // A malformed settings file must not take the whole session list down;
      // degrade to registry-only resolution, exactly as before this existed.
      extra = [];
    }
    return loadRegistryKeys().concat(extra);
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
    const registryKeys = candidateProjectPaths();
    const folders = fs.readdirSync(claudeHomeDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    const sessions = [];
    for (const projectFolder of folders) {
      const resolved = resolveProjectPath(projectFolder, registryKeys);
      const projectDir = path.join(claudeHomeDir, projectFolder);
      // A project folder (or a transcript inside it) can be deleted between
      // the outer readdir and this scan — e.g. `claude` pruning old sessions
      // mid-request. Skip that folder rather than aborting the whole list.
      let files;
      try {
        files = fs.readdirSync(projectDir, { withFileTypes: true })
          .filter((d) => d.isFile() && d.name.endsWith('.jsonl'));
      } catch {
        continue;
      }

      for (const file of files) {
        const filePath = path.join(projectDir, file.name);
        let stat;
        let meta;
        try {
          stat = fs.statSync(filePath);
          meta = getHeadMeta(filePath, stat);
        } catch {
          continue;
        }
        const projectPath = resolved || projectFolder;
        sessions.push({
          id: file.name.replace(/\.jsonl$/, ''),
          projectFolder,
          projectPath,
          projectName: deriveProjectName(projectPath, projectFolder),
          pathResolved: resolved !== null,
          gitBranch: meta.gitBranch,
          title: meta.title,
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

  // Locate a session's transcript file by scanning project folders. The id
  // comes straight from a URL parameter, so reject anything that isn't a
  // plain token before it gets near a path join.
  function getTranscriptPath(sessionId) {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
    if (!fs.existsSync(claudeHomeDir)) return null;
    const folders = fs.readdirSync(claudeHomeDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    for (const projectFolder of folders) {
      const candidate = path.join(claudeHomeDir, projectFolder, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  // Full-transcript parse for the chat view. Returns null when the session
  // doesn't exist. Reuses the same filtering rules as the title scanner:
  // isMeta lines, wrapper artifacts, and tool-result arrays (type:'user'
  // with array content) are not conversation.
  function readMessages(sessionId) {
    const filePath = getTranscriptPath(sessionId);
    if (!filePath) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const messages = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const timestamp = obj.timestamp || null;
      if (obj.type === 'user' && !obj.isMeta && typeof obj.message?.content === 'string') {
        const content = obj.message.content;
        if (isWrapperContent(content)) continue;
        messages.push({ role: 'user', text: content.trim(), timestamp });
      } else if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
        for (const block of obj.message.content) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            messages.push({ role: 'assistant', text: block.text, timestamp });
          } else if (block.type === 'tool_use') {
            messages.push({ role: 'assistant', kind: 'tool', text: summarizeToolUse(block), timestamp });
          }
        }
      }
    }
    return messages;
  }

  function getPendingToolUseSince(sessionId) {
    const filePath = getTranscriptPath(sessionId);
    if (!filePath) return null;
    return pendingToolUseSince(filePath);
  }

  return { listSessions, listProjects, getTranscriptPath, readMessages, getPendingToolUseSince };
}

module.exports = { createSessionStore };
