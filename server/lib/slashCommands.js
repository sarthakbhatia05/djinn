// server/lib/slashCommands.js
//
// Lists the slash-commands/skills available when composing a message for a
// project: a small fixed set of builtins, plus whatever the project itself
// defines under .claude/commands and .claude/skills. Purely a filesystem
// read — never throws, just returns fewer results when things are missing.
const fs = require('fs');
const path = require('path');

// Universally-available commands. Names have no leading slash — the
// frontend is responsible for rendering the "/".
const BUILTIN_COMMANDS = [
  { name: 'clear', description: 'Clear conversation history and free up context' },
  { name: 'compact', description: 'Clear conversation history but keep a summary in context' },
  { name: 'cost', description: 'Show the total cost and duration of the current session' },
  { name: 'help', description: 'Show help and available commands' },
  { name: 'init', description: 'Initialize a new CLAUDE.md file with codebase documentation' },
  { name: 'resume', description: 'Resume a conversation' },
  { name: 'agents', description: 'Manage agent configurations' },
  { name: 'permissions', description: 'Manage allow & deny tool permissions' },
  { name: 'memory', description: 'Edit CLAUDE.md memory files' },
  { name: 'review', description: 'Review a pull request' },
  { name: 'security-review', description: 'Complete a security review of the pending changes' },
  { name: 'model', description: 'Set the AI model for Claude Code' },
];

// Pulls a description out of a command/skill markdown file: prefer the
// `description:` key in YAML frontmatter, else fall back to the first
// non-empty line of the body, else empty string.
function describeMarkdown(content) {
  let body = content;

  if (content.startsWith('---')) {
    const closeIndex = content.indexOf('\n---', 3);
    if (closeIndex !== -1) {
      const frontmatter = content.slice(3, closeIndex);
      body = content.slice(closeIndex + 4);
      const match = frontmatter.match(/^\s*description:\s*(.*)$/m);
      if (match) {
        const value = match[1].trim().replace(/^["']|["']$/g, '');
        if (value.length > 0) return value;
      }
    }
  }

  const firstLine = body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ? firstLine.replace(/^#+\s*/, '') : '';
}

function listProjectCommands(projectPath) {
  const dir = path.join(projectPath, '.claude', 'commands');
  if (!fs.existsSync(dir)) return [];

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const commands = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const filePath = path.join(dir, entry.name);
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    commands.push({
      name: entry.name.slice(0, -3),
      description: describeMarkdown(content),
      source: 'project-command',
    });
  }
  return commands;
}

function listProjectSkills(projectPath) {
  const dir = path.join(projectPath, '.claude', 'skills');
  if (!fs.existsSync(dir)) return [];

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(dir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    let content;
    try {
      content = fs.readFileSync(skillFile, 'utf8');
    } catch {
      continue;
    }
    skills.push({
      name: entry.name,
      description: describeMarkdown(content),
      source: 'project-skill',
    });
  }
  return skills;
}

// Returns { name, description, source } entries, sorted by name and
// deduplicated by name — project-defined commands/skills win over a builtin
// of the same name. Never throws: a missing .claude dir, missing
// subdirectories, or a missing/unreadable projectPath just means fewer
// results (builtins only, in the worst case).
function listSlashCommands(projectPath) {
  const byName = new Map();
  for (const cmd of BUILTIN_COMMANDS) {
    byName.set(cmd.name, { ...cmd, source: 'builtin' });
  }

  if (typeof projectPath === 'string' && projectPath.length > 0 && fs.existsSync(projectPath)) {
    for (const entry of [...listProjectCommands(projectPath), ...listProjectSkills(projectPath)]) {
      byName.set(entry.name, entry);
    }
  }

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { listSlashCommands };
