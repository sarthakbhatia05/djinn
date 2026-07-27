// test/pathEncoding.test.js
const test = require('node:test');
const assert = require('node:assert');
const { encodeProjectPath } = require('../server/lib/pathEncoding');

test('encodes backslashes, colons, and spaces to hyphens', () => {
  assert.strictEqual(
    encodeProjectPath('D:\\Projects\\acme\\acme-web'),
    'D--Projects-acme-acme-web'
  );
});

test('encodes forward-slash paths the same way (registry keys vary)', () => {
  assert.strictEqual(
    encodeProjectPath('D:/Projects/acme/acme-web'),
    'D--Projects-acme-acme-web'
  );
});

test('encodes spaces in path segments', () => {
  assert.strictEqual(
    encodeProjectPath('D:\\Projects\\contoso\\Data Pipeline App'),
    'D--Projects-contoso-Data-Pipeline-App'
  );
});

// Regression: dots were not encoded, so any path containing one produced a
// name that could never match the real folder on disk. That silently broke
// every project under the home directory of a Windows account whose username
// contains a dot — the project resolved to nothing and its sessions vanished
// from the dashboard.
test('encodes dots to hyphens', () => {
  assert.strictEqual(
    encodeProjectPath('C:\\Users\\jane.doe\\projects\\api'),
    'C--Users-jane-doe-projects-api'
  );
});

test('encodes a dotted username alongside every other special character', () => {
  assert.strictEqual(
    encodeProjectPath('C:\\Users\\jane.doe.CORP\\App Data\\my.app'),
    'C--Users-jane-doe-CORP-App-Data-my-app'
  );
});
