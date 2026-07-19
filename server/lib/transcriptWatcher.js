// server/lib/transcriptWatcher.js
const fs = require('fs');

// Per-WebSocket transcript watching for the chat view. The client sends
// { type: 'watch', sessionId } and gets { type: 'transcript-update', sessionId }
// nudges when the transcript file changes; it re-fetches the messages itself
// (fetch-on-nudge). Watches are per-connection and torn down on
// { type: 'unwatch' } or disconnect.
//
// fs.watch fires in bursts while the CLI appends, so nudges are throttled:
// one fires immediately, and at most one more per throttle window covers
// whatever arrived in between.
function createTranscriptWatcher({ getTranscriptPath, watchFn = fs.watch, throttleMs = 300 }) {
  function attach(ws) {
    const watches = new Map(); // sessionId -> { watcher, timer, pending }

    function send(sessionId) {
      try {
        ws.send(JSON.stringify({ type: 'transcript-update', sessionId }));
      } catch {
        // connection is going away; the close handler cleans up
      }
    }

    function notify(sessionId) {
      const entry = watches.get(sessionId);
      if (!entry) return;
      if (entry.timer) {
        entry.pending = true;
        return;
      }
      send(sessionId);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        if (entry.pending) {
          entry.pending = false;
          notify(sessionId);
        }
      }, throttleMs);
    }

    function stopWatch(sessionId) {
      const entry = watches.get(sessionId);
      if (!entry) return;
      entry.watcher.close();
      if (entry.timer) clearTimeout(entry.timer);
      watches.delete(sessionId);
    }

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.type === 'watch' && typeof msg.sessionId === 'string') {
        if (watches.has(msg.sessionId)) return;
        const filePath = getTranscriptPath(msg.sessionId);
        if (!filePath) return;
        let watcher;
        try {
          watcher = watchFn(filePath, () => notify(msg.sessionId));
        } catch {
          return; // file vanished between resolve and watch — nothing to track
        }
        watches.set(msg.sessionId, { watcher, timer: null, pending: false });
      } else if (msg.type === 'unwatch' && typeof msg.sessionId === 'string') {
        stopWatch(msg.sessionId);
      }
    });

    ws.on('close', () => {
      for (const sessionId of [...watches.keys()]) stopWatch(sessionId);
    });
  }

  return { attach };
}

module.exports = { createTranscriptWatcher };
