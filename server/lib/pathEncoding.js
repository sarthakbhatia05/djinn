// Mirrors how Claude Code names the transcript folders under
// ~/.claude/projects. The dot matters and is easy to miss: every Windows
// account whose username contains one (`C:\Users\jane.doe\...`) puts a dot in
// the path of everything under the home directory, and without it here the
// encoded name never matches the real folder — so the project resolves to
// nothing, reports pathResolved:false, and its sessions get filtered out of
// the dashboard entirely. Verified against a real install: of 100+ transcript
// folders on disk, not one contains a literal dot.
function encodeProjectPath(absPath) {
  return absPath.replace(/[:\\/ .]/g, '-');
}

module.exports = { encodeProjectPath };
