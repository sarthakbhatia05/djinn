// server/lib/claudeCli.js
const { spawn } = require('child_process');

function createClaudeCli({ spawnFn = spawn, claudeBin = 'claude', onStatusChange = () => {} } = {}) {
  const running = new Map();

  function isRunning(sessionId) {
    return running.has(sessionId);
  }

  function getActiveCount() {
    return running.size;
  }

  function getActiveIds() {
    return Array.from(running.keys());
  }

  function runOneShot(args, cwd, trackId) {
    return new Promise((resolve, reject) => {
      const child = spawnFn(claudeBin, args, { cwd });
      // `entry` is the exact object stored in `running` — cancel() mutates
      // this same reference (entry.cancelled = true) so the close handler
      // below can tell a caller-initiated kill apart from a real crash.
      const entry = { child, cancelled: false };
      running.set(trackId, entry);
      onStatusChange(trackId, 'running');

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });

      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        running.delete(trackId);
        onStatusChange(trackId, 'idle');
        if (err) reject(err);
        else resolve(value);
      };

      child.on('error', (err) => finish(err));
      child.on('close', (code) => {
        if (code !== 0) {
          if (entry.cancelled) {
            finish(Object.assign(new Error('cancelled'), { cancelled: true }));
          } else {
            finish(new Error(`claude exited with code ${code}: ${stderr}`));
          }
          return;
        }
        try {
          finish(null, JSON.parse(stdout));
        } catch (err) {
          finish(new Error(`failed to parse claude output: ${err.message}`));
        }
      });
    });
  }

  // Kills the child process tracked under trackId, if any. Returns true when
  // a process was found and killed, false when nothing was running under
  // that id (nothing to cancel). The actual cleanup (deleting the running-map
  // entry, firing onStatusChange('idle')) happens in the 'close' handler
  // above once the kill takes effect, not here.
  function cancel(trackId) {
    const entry = running.get(trackId);
    if (!entry) return false;
    entry.cancelled = true;
    entry.child.kill();
    return true;
  }

  // Appends --model/--permission-mode when given a non-empty string. Values
  // are passed through verbatim — no whitelist here, the CLI itself rejects
  // bad permission-mode strings and that surfaces through the normal
  // reject/502 path.
  function appendPassthroughFlags(args, options) {
    if (typeof options.model === 'string' && options.model.length > 0) {
      args.push('--model', options.model);
    }
    if (typeof options.permissionMode === 'string' && options.permissionMode.length > 0) {
      args.push('--permission-mode', options.permissionMode);
    }
    return args;
  }

  function startSession(cwd, message, options = {}) {
    const trackId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const args = appendPassthroughFlags(['--print', message, '--output-format', 'json'], options);
    return runOneShot(args, cwd, trackId);
  }

  function sendMessage(sessionId, cwd, message, options = {}) {
    const args = appendPassthroughFlags(['--resume', sessionId, '--print', message, '--output-format', 'json'], options);
    return runOneShot(args, cwd, sessionId);
  }

  return { isRunning, startSession, sendMessage, getActiveCount, getActiveIds, cancel };
}

module.exports = { createClaudeCli };
