function encodeProjectPath(absPath) {
  return absPath.replace(/[:\\/ ]/g, '-');
}

module.exports = { encodeProjectPath };
