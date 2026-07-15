// server/lib/claudeCli.js
const { spawn } = require('child_process');

function createClaudeCli({ spawnFn = spawn, claudeBin = 'claude', onStatusChange = () => {} } = {}) {
  const running = new Map();

  function isRunning(sessionId) {
    return running.has(sessionId);
  }

  function runOneShot(args, cwd, trackId) {
    return new Promise((resolve, reject) => {
      const child = spawnFn(claudeBin, args, { cwd });
      running.set(trackId, { child });
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
          finish(new Error(`claude exited with code ${code}: ${stderr}`));
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

  function startSession(cwd, message) {
    const trackId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return runOneShot(['--print', message, '--output-format', 'json'], cwd, trackId);
  }

  function sendMessage(sessionId, cwd, message) {
    return runOneShot(['--resume', sessionId, '--print', message, '--output-format', 'json'], cwd, sessionId);
  }

  return { isRunning, startSession, sendMessage };
}

module.exports = { createClaudeCli };
