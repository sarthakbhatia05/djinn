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
