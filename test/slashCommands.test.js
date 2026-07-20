// test/slashCommands.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listSlashCommands } = require('../server/lib/slashCommands');

function tempProjectDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'slash-commands-'));
}

test('returns builtins only when no .claude dir exists', () => {
  const projectPath = tempProjectDir();
  const commands = listSlashCommands(projectPath);
  assert.ok(commands.length > 0);
  assert.ok(commands.every((c) => c.source === 'builtin'));
  assert.ok(commands.some((c) => c.name === 'clear'));
  // sorted by name
  const names = commands.map((c) => c.name);
  assert.deepStrictEqual(names, [...names].sort());
});

test('returns builtins only when projectPath itself does not exist', () => {
  const commands = listSlashCommands('D:\\this\\path\\does\\not\\exist\\at\\all');
  assert.ok(commands.length > 0);
  assert.ok(commands.every((c) => c.source === 'builtin'));
});

test('picks up project commands from .claude/commands', () => {
  const projectPath = tempProjectDir();
  const commandsDir = path.join(projectPath, '.claude', 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.writeFileSync(path.join(commandsDir, 'deploy.md'), 'Deploy the app to production.\n');

  const commands = listSlashCommands(projectPath);
  const deploy = commands.find((c) => c.name === 'deploy');
  assert.ok(deploy, 'expected a "deploy" command');
  assert.strictEqual(deploy.source, 'project-command');
  assert.strictEqual(deploy.description, 'Deploy the app to production.');
});

test('picks up project skills from .claude/skills (subdir with SKILL.md)', () => {
  const projectPath = tempProjectDir();
  const skillDir = path.join(projectPath, '.claude', 'skills', 'my-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'A skill that does things.\n');

  const commands = listSlashCommands(projectPath);
  const skill = commands.find((c) => c.name === 'my-skill');
  assert.ok(skill, 'expected a "my-skill" entry');
  assert.strictEqual(skill.source, 'project-skill');
  assert.strictEqual(skill.description, 'A skill that does things.');
});

test('a subdirectory of .claude/skills without SKILL.md is skipped', () => {
  const projectPath = tempProjectDir();
  const notASkillDir = path.join(projectPath, '.claude', 'skills', 'not-a-skill');
  fs.mkdirSync(notASkillDir, { recursive: true });
  fs.writeFileSync(path.join(notASkillDir, 'notes.txt'), 'just some notes');

  const commands = listSlashCommands(projectPath);
  assert.ok(!commands.some((c) => c.name === 'not-a-skill'));
});

test('a project command overrides a builtin of the same name', () => {
  const projectPath = tempProjectDir();
  const commandsDir = path.join(projectPath, '.claude', 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.writeFileSync(path.join(commandsDir, 'model.md'), 'Custom project override for /model.\n');

  const commands = listSlashCommands(projectPath);
  const modelEntries = commands.filter((c) => c.name === 'model');
  assert.strictEqual(modelEntries.length, 1, 'expected no duplicate "model" entries');
  assert.strictEqual(modelEntries[0].source, 'project-command');
  assert.strictEqual(modelEntries[0].description, 'Custom project override for /model.');
});

test('parses description from YAML frontmatter', () => {
  const projectPath = tempProjectDir();
  const commandsDir = path.join(projectPath, '.claude', 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.writeFileSync(
    path.join(commandsDir, 'ship.md'),
    '---\ndescription: Ship the current branch\n---\nSome body text that should be ignored.\n'
  );

  const commands = listSlashCommands(projectPath);
  const ship = commands.find((c) => c.name === 'ship');
  assert.ok(ship);
  assert.strictEqual(ship.description, 'Ship the current branch');
});

test('falls back to the first non-empty line when there is no frontmatter description', () => {
  const projectPath = tempProjectDir();
  const commandsDir = path.join(projectPath, '.claude', 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.writeFileSync(
    path.join(commandsDir, 'sync.md'),
    '\n\nSync local state with remote.\nMore details below.\n'
  );

  const commands = listSlashCommands(projectPath);
  const sync = commands.find((c) => c.name === 'sync');
  assert.ok(sync);
  assert.strictEqual(sync.description, 'Sync local state with remote.');
});

test('command names have no leading slash', () => {
  const commands = listSlashCommands(tempProjectDir());
  assert.ok(commands.every((c) => !c.name.startsWith('/')));
});
