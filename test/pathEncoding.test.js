// test/pathEncoding.test.js
const test = require('node:test');
const assert = require('node:assert');
const { encodeProjectPath } = require('../server/lib/pathEncoding');

test('encodes backslashes, colons, and spaces to hyphens', () => {
  assert.strictEqual(
    encodeProjectPath('D:\\Projects\\DFM-Project\\oarc-function-app'),
    'D--Projects-DFM-Project-oarc-function-app'
  );
});

test('encodes forward-slash paths the same way (registry keys vary)', () => {
  assert.strictEqual(
    encodeProjectPath('D:/Projects/DFM-Project/oarc-function-app'),
    'D--Projects-DFM-Project-oarc-function-app'
  );
});

test('encodes spaces in path segments', () => {
  assert.strictEqual(
    encodeProjectPath('D:\\Projects\\Mimo-Monitors\\Fuji IoT Python Application'),
    'D--Projects-Mimo-Monitors-Fuji-IoT-Python-Application'
  );
});
