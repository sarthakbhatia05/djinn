// public/sessionSelect.js
// Pure selection logic for the "Running & recent sessions" grid: pinning,
// filtering, sorting, and pagination. Kept free of DOM access so it can be
// unit-tested under node --test (see the guarded export at the bottom, same
// convention as format.js).

// Running sessions are pinned to the top and are exempt from BOTH the project
// filter and the pagination limit. A live agent must never be hidden behind a
// "Load more" button or filtered out of view — surfacing running work is the
// whole point of the dashboard.
function selectSessions(sessions, options) {
  const opts = options || {};
  const sort = opts.sort === 'oldest' ? 'oldest' : 'newest';
  const limit = typeof opts.limit === 'number' ? opts.limit : Infinity;
  const filter = new Set(opts.projectFilter || []);

  const list = Array.isArray(sessions) ? sessions : [];
  const running = [];
  const rest = [];
  for (const session of list) {
    if (session && session.isRunning) running.push(session);
    else if (session) rest.push(session);
  }

  // An empty filter means "all projects".
  const filtered = filter.size === 0 ? rest : rest.filter((s) => filter.has(s.projectPath));

  const direction = sort === 'oldest' ? -1 : 1;
  function byActivity(a, b) {
    const aTime = a.lastActivity || '';
    const bTime = b.lastActivity || '';
    if (aTime === bTime) return 0;
    return (aTime < bTime ? 1 : -1) * direction;
  }

  running.sort(byActivity);
  filtered.sort(byActivity);

  return running.concat(limit === Infinity ? filtered : filtered.slice(0, Math.max(0, limit)));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { selectSessions };
}
