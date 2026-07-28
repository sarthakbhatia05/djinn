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
      // `running` holds exactly one entry per trackId, and sendMessage uses the
      // session id itself as the trackId. Two concurrent sends for the same
      // session therefore used to overwrite each other's entry: whichever child
      // closed first deleted the shared entry and fired onStatusChange(id,
      // 'idle'), so the dashboard showed the session as finished while the
      // other agent was still writing to the same transcript, and cancel()
      // could only ever kill the most recently spawned child. Reject the second
      // one instead. status:409 is read by the error middleware in
      // server/app.js, which passes err.message through for sub-500 statuses.
      // startSession is unaffected — it mints a random `pending-...` trackId per
      // call, so two new sessions started at once cannot collide here.
      if (running.has(trackId)) {
        reject(Object.assign(
          new Error('a run is already in progress for this session — wait for it to finish before sending another message'),
          { status: 409, alreadyRunning: true }
        ));
        return;
      }

      const child = spawnFn(claudeBin, args, { cwd });
      // `entry` is the exact object stored in `running` — cancel() mutates
      // this same reference (entry.cancelled = true) so the close handler
      // below can tell a caller-initiated kill apart from a real crash.
      const entry = { child, cancelled: false };
      running.set(trackId, entry);
      onStatusChange(trackId, 'running');

      // Collect raw bytes and decode once at the end rather than doing
      // `stdout += chunk`, which stringifies every chunk on its own. A stream
      // boundary can fall in the middle of a multi-byte UTF-8 character — the
      // CLI's JSON routinely contains em dashes, accented names and emoji — and
      // each half then decodes to U+FFFD, so the result text comes back
      // mangled and, if the split lands inside a character in a JSON string,
      // JSON.parse below fails outright. Buffering is preferred over
      // setEncoding('utf8') because it keeps the exact bytes available and
      // makes the decode a single explicit step instead of relying on the
      // stream decoder being wired up on both pipes.
      const stdoutChunks = [];
      const stderrChunks = [];
      const toBuffer = (d) => (Buffer.isBuffer(d) ? d : Buffer.from(d));
      child.stdout.on('data', (d) => { stdoutChunks.push(toBuffer(d)); });
      child.stderr.on('data', (d) => { stderrChunks.push(toBuffer(d)); });

      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        // Retire the tracking entry only if it is still *ours*. cancel() drops
        // it synchronously so the next send isn't refused while a killed child
        // takes its time exiting, which means by the time this 'close' arrives
        // the slot may already hold a newer run. Deleting unconditionally would
        // evict that newer entry and broadcast 'idle' over a session that is
        // genuinely working — the exact corruption the same-id guard above
        // exists to prevent, re-entered through the cancel path. The promise
        // settles either way: the caller is owed its result regardless of who
        // currently owns the slot.
        if (running.get(trackId) === entry) {
          running.delete(trackId);
          onStatusChange(trackId, 'idle');
        }
        if (err) reject(err);
        else resolve(value);
      };

      child.on('error', (err) => finish(err));
      child.on('close', (code) => {
        if (code !== 0) {
          if (entry.cancelled) {
            finish(Object.assign(new Error('cancelled'), { cancelled: true }));
          } else {
            finish(new Error(`claude exited with code ${code}: ${Buffer.concat(stderrChunks).toString('utf8')}`));
          }
          return;
        }
        try {
          finish(null, JSON.parse(Buffer.concat(stdoutChunks).toString('utf8')));
        } catch (err) {
          finish(new Error(`failed to parse claude output: ${err.message}`));
        }
      });
    });
  }

  // Kills the child process tracked under trackId, if any. Returns true when
  // a process was found and killed, false when nothing was running under
  // that id (nothing to cancel).
  //
  // The entry is retired here rather than in the 'close' handler. kill() only
  // *requests* an exit, and 'close' can arrive several ticks later — so leaving
  // the entry in place meant the session still counted as running for that
  // window, and the same-id guard in runOneShot refused the very next send with
  // a 409. Pressing Stop and immediately retyping is a completely ordinary
  // thing to do, and it got you an error blaming a run you had just ended.
  // Cancelling *is* the point at which the session stops running, so say so
  // now; finish() checks entry identity before touching the slot, so the late
  // 'close' can no longer double-fire 'idle' or evict whatever replaced us.
  function cancel(trackId) {
    const entry = running.get(trackId);
    if (!entry) return false;
    entry.cancelled = true;
    running.delete(trackId);
    onStatusChange(trackId, 'idle');
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
