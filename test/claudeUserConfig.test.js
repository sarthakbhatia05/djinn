const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getClaudeUserDefaults } = require('../server/lib/claudeUserConfig');

function tempSettingsFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claudeuserconfig-')), 'settings.json');
}

test('returns nulls when the settings file does not exist', () => {
  const settingsPath = tempSettingsFile();
  assert.deepStrictEqual(getClaudeUserDefaults({ settingsPath }), { model: null, permissionMode: null });
});

test('reads a configured model and permission default mode', () => {
  const settingsPath = tempSettingsFile();
  fs.writeFileSync(settingsPath, JSON.stringify({ model: 'sonnet', permissions: { defaultMode: 'default' } }));
  assert.deepStrictEqual(getClaudeUserDefaults({ settingsPath }), { model: 'sonnet', permissionMode: 'default' });
});

test('model is null when absent from the file', () => {
  const settingsPath = tempSettingsFile();
  fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { defaultMode: 'plan' } }));
  assert.deepStrictEqual(getClaudeUserDefaults({ settingsPath }), { model: null, permissionMode: 'plan' });
});

test('permissionMode is null when permissions block is absent', () => {
  const settingsPath = tempSettingsFile();
  fs.writeFileSync(settingsPath, JSON.stringify({ model: 'opus' }));
  assert.deepStrictEqual(getClaudeUserDefaults({ settingsPath }), { model: 'opus', permissionMode: null });
});

test('a blank string model is treated as not configured', () => {
  const settingsPath = tempSettingsFile();
  fs.writeFileSync(settingsPath, JSON.stringify({ model: '   ' }));
  assert.deepStrictEqual(getClaudeUserDefaults({ settingsPath }), { model: null, permissionMode: null });
});

test('malformed JSON degrades to nulls instead of throwing', () => {
  const settingsPath = tempSettingsFile();
  fs.writeFileSync(settingsPath, '{ this is not valid json');
  assert.deepStrictEqual(getClaudeUserDefaults({ settingsPath }), { model: null, permissionMode: null });
});
