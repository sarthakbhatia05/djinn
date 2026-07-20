// public/app.js
(function () {
  const state = {
    sessions: [],
    projects: [],
    backlog: [],
    recentDirs: [],
    activeDetailId: null,
    selectedDirectory: null,
    activeCount: 0,
    settings: null,
    // Cumulative cost/token figures the claude CLI reports per invocation —
    // NOT an account-level quota or rate-limit status (the CLI exposes no
    // such thing). Shape matches GET /api/usage: { allTime, sessions }.
    usage: { allTime: { costUsd: 0, inputTokens: 0, outputTokens: 0, callCount: 0 }, sessions: {} },
    drawerSize: readDrawerSize(), // function declarations hoist, so this is fine
    drawerMinimized: false,
    drawerWidthPx: readDrawerWidthPx(),
  };

  // ---------- assistant identity + tracked projects ----------

  function assistantName() {
    return (state.settings && state.settings.assistantName) || 'Assistant';
  }

  // Same loose comparison the server uses: project paths appear with varying
  // case and slash direction depending on where they were recorded.
  function normalizeClientPath(p) {
    return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  function isTrackedPath(p) {
    if (!state.settings) return true; // settings not loaded yet — hide nothing
    if (!p) return false;
    return state.settings.projects.some((t) => normalizeClientPath(t) === normalizeClientPath(p));
  }

  function trackedProjects() {
    return state.projects.filter((p) => isTrackedPath(p.projectPath));
  }

  function lastPathSegment(p) {
    const segments = String(p).replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
    return segments.length ? segments[segments.length - 1] : String(p);
  }

  function applyAssistantName() {
    const name = state.settings && state.settings.assistantName;
    const titleEl = document.getElementById('header-assistant-name');
    if (titleEl) titleEl.textContent = name ? `${name} · console` : 'console';
    document.title = name ? `${name} — Djinn` : 'Djinn';
    const workingText = document.getElementById('chat-working-text');
    if (workingText) workingText.textContent = `${assistantName()} is working…`;
    updateCommandBarHint();
  }

  // ---------- fetch helper ----------

  // Rolling record of every request failure, so an intermittent "Failed to
  // fetch" can be diagnosed after the fact instead of having to be caught live.
  // Read it from the console with `__dashboardDiag()`.
  const diagLog = [];
  function recordDiag(entry) {
    diagLog.push({ at: new Date().toISOString(), ...entry });
    if (diagLog.length > 100) diagLog.shift();
  }
  window.__dashboardDiag = () => {
    console.table(diagLog);
    return diagLog;
  };

  async function fetchJson(url, options) {
    const method = (options && options.method) || 'GET';
    const startedAt = performance.now();
    let res;
    try {
      res = await fetch(url, options);
    } catch (err) {
      // fetch() rejects (rather than resolving with a bad status) only when the
      // request never completed at the transport layer. The browser's message
      // for this is the bare, endpoint-less string "Failed to fetch", so tag it
      // with what we actually asked for.
      const elapsed = Math.round(performance.now() - startedAt);
      recordDiag({ kind: 'network', method, url, elapsedMs: elapsed, raw: String(err && err.message) });
      const tagged = new Error(`${method} ${url} never completed (${elapsed}ms): ${err && err.message}`);
      tagged.isNetworkError = true;
      tagged.url = url;
      throw tagged;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      recordDiag({ kind: 'http', method, url, status: res.status });
      throw new Error(body.error || `${res.status} ${res.statusText}`);
    }
    return res.status === 204 ? null : res.json();
  }

  // Distinguishes the two ways a request can fail to complete: the server is
  // gone (it crashed) versus the server is fine and a single pooled socket was
  // torn down under us. Only the second is survivable by retrying.
  async function probeServerAlive() {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ---------- toast (lightweight, visible feedback for failures / missing input) ----------

  let toastEl = null;
  let toastTimer = null;
  function showToast(message, isError = true) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'app-toast';
      toastEl.style.position = 'fixed';
      toastEl.style.bottom = '18px';
      toastEl.style.left = '50%';
      toastEl.style.transform = 'translateX(-50%)';
      toastEl.style.padding = '10px 16px';
      toastEl.style.borderRadius = '7px';
      toastEl.style.fontFamily = "'JetBrains Mono', monospace";
      toastEl.style.fontSize = '12.5px';
      toastEl.style.zIndex = '1000';
      toastEl.style.border = '1px solid var(--border)';
      toastEl.style.boxShadow = '0 4px 18px rgba(0,0,0,0.35)';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.style.background = isError ? 'var(--surface-2)' : 'var(--surface)';
    toastEl.style.color = isError ? 'var(--warn)' : 'var(--text)';
    toastEl.style.display = 'block';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toastEl) toastEl.style.display = 'none';
    }, 4000);
  }

  async function guarded(promise, fallbackMessage) {
    try {
      return await promise;
    } catch (err) {
      console.error(fallbackMessage, err);
      if (err && err.isNetworkError) {
        const alive = await probeServerAlive();
        recordDiag({ kind: 'verdict', url: err.url, serverAlive: alive });
        showToast(
          alive
            ? `${fallbackMessage} — connection dropped, server is still up. Retrying on the next refresh.`
            : `${fallbackMessage} — the dashboard server is not responding. Restart it with "npm start".`
        );
        return null;
      }
      showToast(err && err.message ? err.message : fallbackMessage);
      return null;
    }
  }

  // ---------- data loads ----------

  async function loadSessions() {
    const [sessions, activeCountResult, usage] = await Promise.all([
      guarded(fetchJson('/api/sessions'), 'Failed to load sessions'),
      guarded(fetchJson('/api/sessions/active-count'), 'Failed to load active session count'),
      guarded(fetchJson('/api/usage'), 'Failed to load usage'),
    ]);
    if (sessions === null) return;
    state.sessions = sessions;
    state.activeCount = activeCountResult ? activeCountResult.activeCount : 0;
    if (usage !== null) state.usage = usage;
    seedViewedBaseline();
    renderSessions();
    updateHeaderStats();
    updateOpenDetailIfPresent();
  }

  async function loadProjects() {
    const projects = await guarded(fetchJson('/api/projects'), 'Failed to load projects');
    if (projects === null) return;
    state.projects = projects;
    renderProjects();
    updateHeaderStats();
    populateMemoryProjectSelect();
    updateCommandBarHint();
  }

  async function loadBacklog() {
    const backlog = await guarded(fetchJson('/api/backlog'), 'Failed to load backlog');
    if (backlog === null) return;
    state.backlog = backlog;
    renderBacklog();
  }

  function statusOf(session) {
    return session.isRunning ? 'running' : 'idle';
  }

  // ---------- seen/unseen tracking ----------
  //
  // A session is "unseen" when its lastActivity is newer than the last time
  // this browser opened its detail drawer. There's no server-side signal for
  // this (sessions have no read/unread concept), so it's tracked entirely in
  // localStorage, per browser.
  //
  // Two wrinkles this accounts for:
  //  - On the very first load this feature ever runs in a browser, every
  //    session that already exists would otherwise show as "unseen" (nothing
  //    has a stored viewedAt yet). seedViewedBaseline() stamps all
  //    currently-known sessions as viewed-as-of-now exactly once per page
  //    load, so history doesn't light up as new.
  //  - A session this browser just spawned (new-session composer or "Ship")
  //    shouldn't show unseen either, even though it has no prior baseline
  //    entry. markSessionsSeenSince() diffs session ids before/after the
  //    spawn and stamps any that appeared as viewed immediately.
  const VIEWED_SESSIONS_KEY = 'djinn.viewedSessions';
  let viewedBaselineSeeded = false;

  function readViewedMap() {
    try {
      const raw = localStorage.getItem(VIEWED_SESSIONS_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeViewedMap(map) {
    try {
      localStorage.setItem(VIEWED_SESSIONS_KEY, JSON.stringify(map));
    } catch {
      // private mode / storage disabled — non-fatal, just won't persist
    }
  }

  function markSessionViewed(sessionId) {
    const map = readViewedMap();
    map[sessionId] = new Date().toISOString();
    writeViewedMap(map);
  }

  function seedViewedBaseline() {
    if (viewedBaselineSeeded) return;
    viewedBaselineSeeded = true;
    const map = readViewedMap();
    let changed = false;
    for (const s of state.sessions) {
      if (!(s.id in map)) {
        map[s.id] = s.lastActivity || new Date().toISOString();
        changed = true;
      }
    }
    if (changed) writeViewedMap(map);
  }

  // Call with the set of session ids known before an action that may have
  // spawned a new one; any id present now that wasn't in that set is marked
  // viewed, since this browser just created it.
  function markSessionsSeenSince(priorIds) {
    const map = readViewedMap();
    let changed = false;
    for (const s of state.sessions) {
      if (!priorIds.has(s.id) && !(s.id in map)) {
        map[s.id] = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) writeViewedMap(map);
  }

  function isSessionUnseen(session) {
    if (!session.lastActivity) return false;
    const map = readViewedMap();
    const viewedAt = map[session.id];
    if (!viewedAt) return true;
    return new Date(session.lastActivity).getTime() > new Date(viewedAt).getTime();
  }

  // ---------- sessions grid (incremental render so the one-time card-in
  // animation defined on the base .card class doesn't replay on every poll) ----------

  function buildCardSkeleton(card, session) {
    card.className = 'card';
    card.dataset.sessionId = session.id;
    card.innerHTML = `
      <div class="card-top">
        <div class="card-status">
          <span class="status-dot"></span>
          <span class="eyebrow card-status-label"></span>
          <span class="card-unseen-badge" title="New activity since you last opened this"></span>
        </div>
        <span class="dotnum card-time"></span>
      </div>
      <div class="card-title"></div>
      <div class="card-meta mono">
        <span class="card-meta-path"></span>
      </div>
    `;
    card.addEventListener('click', () => openDetail(session.id));
  }

  function updateCardContent(card, session) {
    const status = statusOf(session);
    const dot = card.querySelector('.status-dot');
    dot.classList.toggle('status-dot--pulse-fast', status === 'running');

    const label = card.querySelector('.card-status-label');
    label.textContent = status === 'running' ? 'Running' : 'Idle';
    label.classList.toggle('card-status-label--running', status === 'running');
    label.classList.toggle('card-status-label--done', status !== 'running');

    const unseenBadge = card.querySelector('.card-unseen-badge');
    if (unseenBadge) unseenBadge.classList.toggle('card-status-label--unseen', isSessionUnseen(session));

    card.querySelector('.card-time').textContent = formatRelativeTime(session.lastActivity);
    card.querySelector('.card-title').textContent = session.title || '(no summary yet)';
    card.querySelector('.card-meta-path').textContent =
      `${session.projectName || session.projectFolder}${session.gitBranch ? ' · ' + session.gitBranch : ''}`;

    card.classList.toggle('card--active', session.id === state.activeDetailId);
  }

  // ---------- sessions grid: sort / filter / pagination ----------

  const SESSION_PAGE_SIZE = 6;
  const SESSION_SORT_KEY = 'djinn.sessionSort';

  // Sort persists across reloads; the project filter deliberately does not, so
  // a fresh load always shows everything.
  const sessionView = {
    sort: 'newest',
    projectFilter: [],
    limit: SESSION_PAGE_SIZE,
  };

  function loadSessionSort() {
    try {
      const stored = localStorage.getItem(SESSION_SORT_KEY);
      if (stored === 'newest' || stored === 'oldest') sessionView.sort = stored;
    } catch {
      // private-mode / disabled storage — the in-memory default is fine
    }
  }

  function saveSessionSort() {
    try {
      localStorage.setItem(SESSION_SORT_KEY, sessionView.sort);
    } catch {
      // ignore
    }
  }

  // Any change to sort or filter starts the user over at the first page.
  function resetSessionPagination() {
    sessionView.limit = SESSION_PAGE_SIZE;
  }

  function visibleSessions() {
    return selectSessions(state.sessions, {
      sort: sessionView.sort,
      projectFilter: sessionView.projectFilter,
      limit: sessionView.limit,
    });
  }

  // Same selection with pagination lifted, so "remaining" counts exactly the
  // sessions that a further "Load more" would reveal.
  function selectableSessionCount() {
    return selectSessions(state.sessions, {
      sort: sessionView.sort,
      projectFilter: sessionView.projectFilter,
      limit: Infinity,
    }).length;
  }

  // Projects present in the currently loaded sessions, with their counts.
  function sessionProjectCounts() {
    const byPath = new Map();
    for (const s of state.sessions) {
      const existing = byPath.get(s.projectPath);
      if (existing) existing.count += 1;
      else byPath.set(s.projectPath, {
        projectPath: s.projectPath,
        projectName: s.projectName || s.projectFolder,
        count: 1,
      });
    }
    return [...byPath.values()].sort((a, b) => a.projectName.localeCompare(b.projectName));
  }

  function renderSessionControls() {
    const sortBtn = document.getElementById('session-sort-btn');
    if (sortBtn) sortBtn.textContent = sessionView.sort === 'newest' ? 'Newest first' : 'Oldest first';

    const filterBtn = document.getElementById('session-filter-btn');
    if (filterBtn) {
      const n = sessionView.projectFilter.length;
      filterBtn.textContent = n === 0 ? 'Projects: All' : `Projects: ${n} selected`;
    }

    const options = document.getElementById('session-filter-options');
    if (options) {
      options.innerHTML = '';
      const selected = new Set(sessionView.projectFilter);
      for (const project of sessionProjectCounts()) {
        const label = document.createElement('label');
        label.className = 'session-filter-option';
        label.title = project.projectPath;
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = selected.has(project.projectPath);
        checkbox.addEventListener('change', () => {
          toggleProjectFilter(project.projectPath, checkbox.checked);
        });
        const name = document.createElement('span');
        name.className = 'session-filter-option-name';
        name.textContent = `${project.projectName} (${project.count})`;
        label.appendChild(checkbox);
        label.appendChild(name);
        options.appendChild(label);
      }
    }

    const moreRow = document.getElementById('session-more-row');
    const moreBtn = document.getElementById('session-more-btn');
    if (moreRow && moreBtn) {
      const remaining = selectableSessionCount() - visibleSessions().length;
      if (remaining > 0) {
        moreRow.style.display = '';
        moreBtn.textContent = `Load more (${remaining} remaining)`;
      } else {
        moreRow.style.display = 'none';
      }
    }
  }

  function toggleProjectFilter(projectPath, checked) {
    const without = sessionView.projectFilter.filter((p) => p !== projectPath);
    sessionView.projectFilter = checked ? without.concat(projectPath) : without;
    resetSessionPagination();
    renderSessions();
  }

  function wireSessionControls() {
    loadSessionSort();

    const sortBtn = document.getElementById('session-sort-btn');
    if (sortBtn) {
      sortBtn.addEventListener('click', () => {
        sessionView.sort = sessionView.sort === 'newest' ? 'oldest' : 'newest';
        saveSessionSort();
        resetSessionPagination();
        renderSessions();
      });
    }

    const filterBtn = document.getElementById('session-filter-btn');
    const filterMenu = document.getElementById('session-filter-menu');
    if (filterBtn && filterMenu) {
      filterBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        filterMenu.style.display = filterMenu.style.display === 'none' ? '' : 'none';
      });
      document.addEventListener('click', (e) => {
        const root = document.getElementById('session-filter');
        if (root && !root.contains(e.target)) filterMenu.style.display = 'none';
      });
    }

    const resetBtn = document.getElementById('session-filter-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        sessionView.projectFilter = [];
        resetSessionPagination();
        renderSessions();
      });
    }

    const moreBtn = document.getElementById('session-more-btn');
    if (moreBtn) {
      moreBtn.addEventListener('click', () => {
        sessionView.limit += SESSION_PAGE_SIZE;
        renderSessions();
      });
    }
  }

  function renderSessions() {
    const grid = document.getElementById('session-grid');

    if (state.sessions.length === 0) {
      renderSessionControls();
      const noTracked = state.settings && state.settings.projects.length === 0;
      grid.innerHTML = '<div class="empty-state"></div>';
      grid.firstChild.textContent = noTracked
        ? 'No projects tracked yet — open “Projects” in the header to choose some.'
        : 'No sessions in your tracked projects yet.';
      return;
    }
    // If the grid currently holds only the empty-state placeholder, clear it
    // before switching to card rendering.
    if (grid.querySelector('.empty-state')) grid.innerHTML = '';

    const existingById = new Map();
    for (const child of Array.from(grid.children)) {
      if (child.dataset && child.dataset.sessionId) existingById.set(child.dataset.sessionId, child);
    }

    const seen = new Set();
    let previousEl = null;
    for (const session of visibleSessions()) {
      const id = String(session.id);
      seen.add(id);
      let card = existingById.get(id);
      if (!card) {
        card = document.createElement('div');
        buildCardSkeleton(card, session); // new node -> gets the card-in animation once
      }
      updateCardContent(card, session);

      const targetPosition = previousEl ? previousEl.nextSibling : grid.firstChild;
      if (targetPosition !== card) grid.insertBefore(card, targetPosition);
      previousEl = card;
    }

    for (const [id, el] of existingById) {
      if (!seen.has(id)) el.remove();
    }

    renderSessionControls();
  }

  // ---------- projects sidebar ----------

  function renderProjects() {
    const list = document.getElementById('project-list');
    list.innerHTML = '';
    const visible = trackedProjects();
    if (visible.length === 0) {
      list.innerHTML = '<div class="empty-state">No tracked projects.</div>';
      return;
    }
    for (const project of visible) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `
        <span class="status-dot project-row-dot"></span>
        <div class="project-row-info">
          <div class="project-row-name"></div>
          <div class="mono project-row-path"></div>
        </div>
        <div class="dotnum row-count"></div>
      `;
      row.querySelector('.project-row-name').textContent = project.projectName || project.projectFolder;
      row.querySelector('.project-row-path').textContent = project.projectPath;
      row.querySelector('.row-count').textContent = String(project.sessionCount);
      list.appendChild(row);
    }
  }

  // ---------- backlog ----------

  function renderBacklog() {
    const list = document.getElementById('backlog-list');
    list.innerHTML = '';
    const visibleBacklog = state.backlog.filter((i) => isTrackedPath(i.repoPath));
    if (visibleBacklog.length === 0) {
      list.innerHTML = '<div class="empty-state">Nothing queued.</div>';
    } else {
      for (const item of visibleBacklog) {
        const row = document.createElement('div');
        row.className = 'backlog-row';
        const priority = item.priority || 'medium';
        // Static template only — item.title is user-supplied and is assigned
        // via textContent below. Never interpolate it into innerHTML.
        row.innerHTML = `
          <input type="checkbox" class="backlog-checkbox" />
          <div class="backlog-row-title"></div>
          <div class="backlog-priority"></div>
          <div class="mono backlog-row-project"></div>
          <button type="button" class="backlog-assign-btn">Ship &rarr;</button>
          <button type="button" class="backlog-delete-btn" title="Remove from backlog">&times;</button>
        `;
        const checkbox = row.querySelector('.backlog-checkbox');
        checkbox.checked = !!item.done;
        checkbox.addEventListener('change', (e) => toggleBacklogItem(item.id, e.target.checked));

        const titleEl = row.querySelector('.backlog-row-title');
        titleEl.textContent = item.title;
        if (item.done) titleEl.style.textDecoration = 'line-through';

        const priorityEl = row.querySelector('.backlog-priority');
        priorityEl.textContent = priority;
        priorityEl.classList.add(`backlog-priority--${priority}`);

        row.querySelector('.backlog-row-project').textContent = item.repoPath;

        const shipBtn = row.querySelector('.backlog-assign-btn');
        if (item.done) {
          shipBtn.remove();
        } else {
          shipBtn.addEventListener('click', () => shipBacklogItem(item, shipBtn));
        }

        row
          .querySelector('.backlog-delete-btn')
          .addEventListener('click', () => deleteBacklogItem(item));

        list.appendChild(row);
      }
    }

    const queued = visibleBacklog.filter((i) => !i.done).length;
    const countEl = document.getElementById('backlog-count');
    if (countEl) countEl.textContent = `${queued} queued`;
  }

  async function toggleBacklogItem(id, done) {
    const result = await guarded(
      fetchJson(`/api/backlog/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ done }),
      }),
      'Failed to update backlog item'
    );
    if (result === null) return;
    await loadBacklog();
  }

  // Hands the item to a real Claude Code agent: its repoPath is already the
  // `cwd` the sessions endpoint wants, and its title is already the prompt.
  // This spawns a process and spends tokens, so the button is latched for the
  // whole (potentially multi-minute) blocking request.
  async function shipBacklogItem(item, button) {
    if (!item.repoPath) {
      showToast('This backlog item has no project directory, so it cannot be shipped.');
      return;
    }
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = 'Shipping…';
    showToast(`${assistantName()} is on it — ${item.title}`, false);
    const result = await guarded(
      fetchJson('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: item.repoPath, message: item.title }),
      }),
      'Failed to ship backlog item'
    );
    if (result === null) {
      button.disabled = false;
      button.textContent = 'Ship →';
      return;
    }
    // Close the loop using the status field that already exists.
    await guarded(
      fetchJson(`/api/backlog/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ done: true }),
      }),
      'Shipped, but failed to mark the backlog item done'
    );
    showToast(`${assistantName()} finished — session added.`, false);
    await Promise.all([loadSessions(), loadProjects(), loadBacklog(), loadRecentDirectories()]);
  }

  async function deleteBacklogItem(item) {
    if (!window.confirm(`Remove "${item.title}" from the backlog?`)) return;
    // DELETE answers 204, which fetchJson reports as null — the same value
    // guarded returns on failure. Since the two are indistinguishable here,
    // always resync: guarded has already surfaced any error in a toast, and
    // reloading is harmless either way.
    await guarded(
      fetchJson(`/api/backlog/${item.id}`, { method: 'DELETE' }),
      'Failed to remove backlog item'
    );
    await loadBacklog();
  }

  async function addBacklogItem(title, repoPath) {
    if (!title || !title.trim()) {
      showToast('Type a task title before adding it to the backlog.');
      return;
    }
    if (!repoPath) {
      showToast('Pick a directory (use "+ New session") before adding a backlog item.');
      return;
    }
    const result = await guarded(
      fetchJson('/api/backlog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, repoPath }),
      }),
      'Failed to add backlog item'
    );
    if (result === null) return;
    await loadBacklog();
  }

  // ---------- chat panel (detail drawer) ----------

  function watchSession(sessionId) {
    sendWsMessage({ type: 'watch', sessionId });
  }

  function unwatchSession(sessionId) {
    sendWsMessage({ type: 'unwatch', sessionId });
  }

  function openDetail(sessionId) {
    const session = state.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    if (state.activeDetailId && state.activeDetailId !== sessionId) {
      unwatchSession(state.activeDetailId);
    }
    const isSwitch = state.activeDetailId !== sessionId;
    state.activeDetailId = sessionId;
    markSessionViewed(sessionId);
    // The unseen badge on this card needs to clear immediately, not wait for
    // the next poll.
    for (const child of document.getElementById('session-grid').children) {
      if (child.dataset && child.dataset.sessionId === sessionId) {
        const badge = child.querySelector('.card-unseen-badge');
        if (badge) badge.classList.remove('card-status-label--unseen');
      }
    }
    renderDetail(session);
    if (isSwitch) {
      const history = document.getElementById('chat-history');
      if (history) history.innerHTML = '';
      loadChatMessages(sessionId);
      watchSession(sessionId);
      closeSlashPopup();
      closeMcpPanel();
    }
    // reflect the active card highlight without a full grid rebuild
    for (const child of document.getElementById('session-grid').children) {
      if (child.dataset) child.classList.toggle('card--active', child.dataset.sessionId === sessionId);
    }
  }

  function renderDetail(session) {
    const drawer = document.getElementById('detail-drawer');
    drawer.style.display = 'flex';
    // Opening a session always un-minimizes; the persisted width is restored.
    state.drawerMinimized = false;
    applyDrawerSize();
    const status = statusOf(session);

    const dot = document.getElementById('detail-status-dot');
    if (dot) dot.classList.toggle('status-dot--pulse-fast', status === 'running');

    const label = document.getElementById('detail-status-label');
    if (label) {
      label.textContent = status === 'running' ? 'Running' : 'Idle';
      label.style.color = status === 'running' ? 'var(--accent)' : 'var(--text-faint)';
    }

    const cancelBtn = document.getElementById('detail-cancel-btn');
    if (cancelBtn) {
      cancelBtn.hidden = status !== 'running';
      cancelBtn.disabled = false;
      cancelBtn.textContent = 'Stop';
    }

    drawer.querySelector('.detail-title').textContent = session.title || '(no summary yet)';
    drawer.querySelector('.detail-meta').textContent =
      `${session.projectName || session.projectFolder}${session.gitBranch ? ' · ' + session.gitBranch : ''}`;

    // Per-session cost the claude CLI has reported for this session so far
    // (summed across every dashboard-sent message). Hidden entirely until
    // there's at least one recorded call — most sessions opened from a
    // terminal, not the dashboard, will never have a claude-CLI-JSON figure
    // for the dashboard to show.
    const usageEl = document.getElementById('detail-usage');
    if (usageEl) {
      const sessionUsage = state.usage && state.usage.sessions && state.usage.sessions[session.id];
      if (sessionUsage && sessionUsage.callCount > 0) {
        usageEl.textContent = `Session cost: ${formatCurrency(sessionUsage.costUsd)}`;
        usageEl.hidden = false;
      } else {
        usageEl.hidden = true;
      }
    }
  }

  async function loadChatMessages(sessionId) {
    const result = await guarded(
      fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/messages`),
      'Failed to load the conversation'
    );
    // The user may have switched or closed the panel while this was in flight.
    if (result === null || state.activeDetailId !== sessionId) return;
    renderChatMessages(result.messages);
  }

  // ---------- chat markdown rendering ----------
  //
  // Renders a small subset of Markdown as real DOM nodes — never innerHTML,
  // never a raw-string HTML parse. Message text is user/model-authored and
  // therefore untrusted; every leaf of text goes through textContent.
  // Handles: **bold**, *italic*/_italic_, `inline code`, ```fenced code```,
  // # / ## headers, and -/*/numbered lists. Anything else (the common case —
  // plain paragraphs with no markdown at all) takes a fast textContent path.

  const MARKDOWN_HINT_RE = /```|`[^`]+`|\*\*[^*]+\*\*|(?:^|\n)#{1,2}\s|(?:^|\n)[-*]\s|(?:^|\n)\d+\.\s|_[^_]+_|\*[^*]+\*/;

  function renderMarkdownInto(container, text) {
    container.textContent = '';
    if (!text) return;
    if (!MARKDOWN_HINT_RE.test(text)) {
      container.textContent = text;
      return;
    }
    for (const part of splitFencedCode(text)) {
      if (part.type === 'code') {
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = part.text;
        pre.appendChild(code);
        container.appendChild(pre);
      } else if (part.text) {
        renderMarkdownBlock(container, part.text);
      }
    }
  }

  // Pulls out ```fenced code blocks``` first, since their contents must never
  // be interpreted as markdown themselves (no bold/list parsing inside code).
  function splitFencedCode(text) {
    const parts = [];
    const re = /```[^\n]*\n?([\s\S]*?)```/g;
    let lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > lastIndex) parts.push({ type: 'text', text: text.slice(lastIndex, m.index) });
      parts.push({ type: 'code', text: m[1].replace(/\n$/, '') });
      lastIndex = re.lastIndex;
    }
    if (lastIndex < text.length) parts.push({ type: 'text', text: text.slice(lastIndex) });
    return parts;
  }

  // Line-based block parser for one non-code segment: groups consecutive
  // list-item lines into <ul>/<ol>, recognizes # / ## headers, and treats
  // runs of plain lines as a paragraph (joined with <br>, not raw "\n", since
  // these are now real elements rather than a single pre-wrapped text node).
  function renderMarkdownBlock(container, text) {
    const lines = text.split('\n');
    let i = 0;
    let paragraphLines = [];

    function flushParagraph() {
      if (paragraphLines.length === 0) return;
      const p = document.createElement('p');
      p.className = 'chat-md-p';
      paragraphLines.forEach((line, idx) => {
        if (idx > 0) p.appendChild(document.createElement('br'));
        appendInlineMarkdown(p, line);
      });
      container.appendChild(p);
      paragraphLines = [];
    }

    while (i < lines.length) {
      const line = lines[i];
      const headerMatch = /^(#{1,2})\s+(.*)$/.exec(line);
      const ulMatch = /^[-*]\s+(.*)$/.exec(line);
      const olMatch = /^\d+\.\s+(.*)$/.exec(line);

      if (headerMatch) {
        flushParagraph();
        const h = document.createElement(headerMatch[1].length === 1 ? 'h4' : 'h5');
        h.className = 'chat-md-heading';
        appendInlineMarkdown(h, headerMatch[2]);
        container.appendChild(h);
        i++;
        continue;
      }

      if (ulMatch || olMatch) {
        flushParagraph();
        const ordered = !!olMatch;
        const list = document.createElement(ordered ? 'ol' : 'ul');
        list.className = 'chat-md-list';
        while (i < lines.length) {
          const itemMatch = ordered ? /^\d+\.\s+(.*)$/.exec(lines[i]) : /^[-*]\s+(.*)$/.exec(lines[i]);
          if (!itemMatch) break;
          const li = document.createElement('li');
          appendInlineMarkdown(li, itemMatch[1]);
          list.appendChild(li);
          i++;
        }
        container.appendChild(list);
        continue;
      }

      if (line.trim() === '') {
        flushParagraph();
        i++;
        continue;
      }

      paragraphLines.push(line);
      i++;
    }
    flushParagraph();
  }

  // Inline spans within one line: `code`, **bold**, *italic*/_italic_. Plain
  // runs of text become text nodes — no element, no innerHTML, ever.
  function appendInlineMarkdown(parent, text) {
    const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_/g;
    let lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > lastIndex) parent.appendChild(document.createTextNode(text.slice(lastIndex, m.index)));
      if (m[1] !== undefined) {
        const code = document.createElement('code');
        code.className = 'chat-md-code';
        code.textContent = m[1];
        parent.appendChild(code);
      } else if (m[2] !== undefined) {
        const strong = document.createElement('strong');
        strong.textContent = m[2];
        parent.appendChild(strong);
      } else {
        const em = document.createElement('em');
        em.textContent = m[3] !== undefined ? m[3] : m[4];
        parent.appendChild(em);
      }
      lastIndex = re.lastIndex;
    }
    if (lastIndex < text.length) parent.appendChild(document.createTextNode(text.slice(lastIndex)));
  }

  function renderChatMessages(messages) {
    const container = document.getElementById('chat-history');
    if (!container) return;
    // Only auto-stick to the bottom if the user was already reading the tail.
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
    container.innerHTML = '';

    if (!messages || messages.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'chat-empty';
      empty.textContent = `No conversation yet — say something to ${assistantName()}.`;
      container.appendChild(empty);
      return;
    }

    for (const msg of messages) {
      const row = document.createElement('div');
      const isUser = msg.role === 'user';
      row.className = `chat-row chat-row--${isUser ? 'user' : 'assistant'}`;
      if (!isUser && msg.kind !== 'tool') {
        const avatar = document.createElement('span');
        avatar.className = 'orb orb--dot';
        row.appendChild(avatar);
      }
      const bubble = document.createElement('div');
      bubble.className = `chat-msg chat-msg--${msg.kind === 'tool' ? 'tool' : (isUser ? 'user' : 'assistant')}`;
      renderMarkdownInto(bubble, msg.text); // user/model text — never innerHTML
      row.appendChild(bubble);
      container.appendChild(row);
    }
    if (nearBottom || container.scrollTop === 0) container.scrollTop = container.scrollHeight;
  }

  function updateOpenDetailIfPresent() {
    if (!state.activeDetailId) return;
    const session = state.sessions.find((s) => s.id === state.activeDetailId);
    if (session) renderDetail(session);
  }

  // Killing a running agent mid-task can lose in-progress work, so this asks
  // first — same window.confirm pattern used for deleting a backlog item.
  // On success the running indicator is greyed out immediately (optimistic);
  // the next WebSocket session-status push or poll will confirm or correct it.
  async function cancelRunningSession() {
    const sessionId = state.activeDetailId;
    if (!sessionId) return;
    if (!window.confirm('Cancel this running session? Any in-progress work may be lost.')) return;

    const btn = document.getElementById('detail-cancel-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Cancelling…'; }

    const result = await guarded(
      fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: 'POST' }),
      'Failed to cancel the session'
    );

    if (result === null || !result.cancelled) {
      if (btn) { btn.disabled = false; btn.textContent = 'Stop'; }
      return;
    }

    showToast('Session cancelled.', false);
    const session = state.sessions.find((s) => s.id === sessionId);
    if (session) session.isRunning = false;
    renderSessions();
    updateHeaderStats();
    if (state.activeDetailId === sessionId && session) renderDetail(session);
    await loadSessions();
  }

  function closeDetail() {
    if (state.activeDetailId) unwatchSession(state.activeDetailId);
    state.activeDetailId = null;
    closeSlashPopup();
    const drawer = document.getElementById('detail-drawer');
    drawer.style.display = 'none';
    // Closing a full-width drawer must give the main column back, or the
    // dashboard stays hidden behind a drawer that is no longer there.
    const main = document.querySelector('.main');
    if (main) main.classList.remove('main--drawer-full');
    for (const child of document.getElementById('session-grid').children) {
      if (child.dataset) child.classList.remove('card--active');
    }
  }

  // ---------- drawer sizing ----------
  //
  // Width cycles normal → wide → full and persists, because a preference for
  // reading long transcripts wide shouldn't have to be re-set every reload.
  // Minimize is deliberately NOT persisted: reopening a session you asked to
  // see, only to get a collapsed strip, would read as a bug.

  const DRAWER_SIZES = ['normal', 'wide', 'full'];
  const DRAWER_SIZE_KEY = 'djinn.drawerSize';
  const DRAWER_WIDTH_PX_KEY = 'djinn.drawerWidthPx';
  const DRAWER_MIN_WIDTH_PX = 320;

  function readDrawerSize() {
    try {
      const saved = localStorage.getItem(DRAWER_SIZE_KEY);
      return DRAWER_SIZES.includes(saved) ? saved : 'normal';
    } catch {
      return 'normal'; // private mode / storage disabled
    }
  }

  // A freely-dragged width (see wireDrawerResize) overrides the normal/wide/
  // full presets via an inline style. Clicking the cycle-size button clears
  // it and returns to preset behavior.
  function readDrawerWidthPx() {
    try {
      const raw = localStorage.getItem(DRAWER_WIDTH_PX_KEY);
      const n = raw ? parseInt(raw, 10) : NaN;
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  }

  function saveDrawerWidthPx(px) {
    try { localStorage.setItem(DRAWER_WIDTH_PX_KEY, String(px)); } catch { /* non-fatal */ }
  }

  function clearDrawerWidthPx() {
    try { localStorage.removeItem(DRAWER_WIDTH_PX_KEY); } catch { /* non-fatal */ }
  }

  function applyDrawerSize() {
    const drawer = document.getElementById('detail-drawer');
    if (!drawer) return;
    drawer.classList.toggle('drawer--wide', state.drawerSize === 'wide');
    drawer.classList.toggle('drawer--full', state.drawerSize === 'full');
    drawer.classList.toggle('drawer--min', state.drawerMinimized);

    // Inline width wins over the preset classes; clearing it (drawerWidthPx
    // === null) hands width back to whichever preset class is toggled above.
    drawer.style.width = state.drawerWidthPx ? `${state.drawerWidthPx}px` : '';

    // At full width .main-content still contributes its horizontal padding, so
    // a sliver of it survives beside the drawer. Take it out of flow instead.
    const main = document.querySelector('.main');
    if (main) {
      main.classList.toggle('main--drawer-full', state.drawerSize === 'full' && !state.drawerMinimized);
    }

    const sizeBtn = document.getElementById('detail-size-btn');
    if (sizeBtn) {
      sizeBtn.textContent = state.drawerSize === 'full' ? '⤡' : '⤢';
      sizeBtn.title = state.drawerSize === 'full' ? 'Back to normal width' : 'Widen the panel';
    }
    const minBtn = document.getElementById('detail-minimize-btn');
    if (minBtn) {
      minBtn.textContent = state.drawerMinimized ? '□' : '—';
      minBtn.title = state.drawerMinimized ? 'Restore' : 'Minimize';
    }
  }

  function cycleDrawerSize() {
    const next = (DRAWER_SIZES.indexOf(state.drawerSize) + 1) % DRAWER_SIZES.length;
    state.drawerSize = DRAWER_SIZES[next];
    // Widening a minimized drawer should show you the result, not stay collapsed.
    state.drawerMinimized = false;
    // The cycle button is the explicit "back to presets" control.
    state.drawerWidthPx = null;
    clearDrawerWidthPx();
    try { localStorage.setItem(DRAWER_SIZE_KEY, state.drawerSize); } catch { /* non-fatal */ }
    applyDrawerSize();
  }

  function toggleDrawerMinimized() {
    state.drawerMinimized = !state.drawerMinimized;
    applyDrawerSize();
  }

  // Free-drag resize via the handle on the drawer's left edge. Dragging left
  // (away from the drawer's own right-anchored edge) grows it; the resulting
  // pixel width is applied as an inline style and persisted, and wins over
  // whichever preset class is active until the size button is clicked.
  function wireDrawerResize() {
    const handle = document.getElementById('drawer-resize-handle');
    const drawer = document.getElementById('detail-drawer');
    if (!handle || !drawer) return;

    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    const onMouseMove = (e) => {
      if (!dragging) return;
      const deltaX = startX - e.clientX;
      const max = Math.floor(window.innerWidth * 0.95);
      const newWidth = Math.max(DRAWER_MIN_WIDTH_PX, Math.min(max, startWidth + deltaX));
      state.drawerWidthPx = newWidth;
      drawer.style.width = `${newWidth}px`;
    };
    const onMouseUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      if (state.drawerWidthPx) saveDrawerWidthPx(state.drawerWidthPx);
    };

    handle.addEventListener('mousedown', (e) => {
      if (state.drawerMinimized || state.drawerSize === 'full') return;
      dragging = true;
      startX = e.clientX;
      startWidth = drawer.getBoundingClientRect().width;
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }

  // ---------- model / permission-mode selectors ----------
  //
  // One shared preference each, persisted per browser and mirrored across
  // both places it's offered (the drawer footer for follow-ups, the command
  // bar for new sessions) so picking a model in one doesn't reset when you
  // open the other. Empty string means "default" and is omitted from the
  // request body entirely, matching what the two send paths already do for
  // other optional fields.
  const MODEL_PREF_KEY = 'djinn.model';
  const PERMISSION_PREF_KEY = 'djinn.permissionMode';
  const PERMISSION_MODES = ['plan', 'acceptEdits', 'bypassPermissions', 'manual'];

  function readModelPref() {
    try {
      return localStorage.getItem(MODEL_PREF_KEY) || '';
    } catch {
      return '';
    }
  }

  function saveModelPref(value) {
    try { localStorage.setItem(MODEL_PREF_KEY, value || ''); } catch { /* non-fatal */ }
  }

  function readPermissionPref() {
    try {
      const saved = localStorage.getItem(PERMISSION_PREF_KEY) || '';
      return PERMISSION_MODES.includes(saved) ? saved : '';
    } catch {
      return '';
    }
  }

  function savePermissionPref(value) {
    try { localStorage.setItem(PERMISSION_PREF_KEY, value || ''); } catch { /* non-fatal */ }
  }

  const MODEL_SELECT_IDS = ['command-model-select', 'detail-model-select'];
  const PERMISSION_SELECT_IDS = ['command-permission-select', 'detail-permission-select'];

  function applyControlPrefsToSelects() {
    const model = readModelPref();
    const permission = readPermissionPref();
    for (const id of MODEL_SELECT_IDS) {
      const el = document.getElementById(id);
      if (el) el.value = model;
    }
    for (const id of PERMISSION_SELECT_IDS) {
      const el = document.getElementById(id);
      if (el) {
        el.value = permission;
        el.classList.toggle('control-select--armed', !!permission);
      }
    }
  }

  function wireControlSelects() {
    for (const id of MODEL_SELECT_IDS) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.addEventListener('change', () => {
        saveModelPref(el.value);
        applyControlPrefsToSelects();
      });
    }
    for (const id of PERMISSION_SELECT_IDS) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.addEventListener('change', () => {
        savePermissionPref(el.value);
        applyControlPrefsToSelects();
      });
    }
  }

  // "Default" left people guessing what it actually resolves to, so once we
  // know the user's real configured default (read server-side from their own
  // ~/.claude/settings.json — see claudeUserConfig.js), the option text grows
  // a bracket: "Default (Sonnet)". Best-effort only: if nothing is configured
  // or the fetch fails, the option stays plain "Default".
  const MODEL_DEFAULT_LABELS = {
    opus: 'Opus',
    sonnet: 'Sonnet',
    haiku: 'Haiku',
    fable: 'Fable',
    'claude-opus-4-8': 'Opus',
    'claude-sonnet-5': 'Sonnet',
    'claude-haiku-4-5-20251001': 'Haiku',
    'claude-fable-5': 'Fable',
  };
  const PERMISSION_DEFAULT_LABELS = {
    plan: 'Plan',
    acceptEdits: 'Accept Edits',
    bypassPermissions: 'Bypass Permissions',
    manual: 'Manual',
    auto: 'Auto',
    dontAsk: "Don't Ask",
    default: 'asks before risky actions',
  };

  function labelDefaultOption(selectId, text) {
    const el = document.getElementById(selectId);
    const opt = el && el.querySelector('option[value=""]');
    if (opt) opt.textContent = text;
  }

  async function loadClaudeDefaultsLabel() {
    const result = await fetchJson('/api/claude-defaults').catch(() => null);
    if (!result) return;
    if (result.model) {
      const label = MODEL_DEFAULT_LABELS[result.model] || result.model;
      for (const id of MODEL_SELECT_IDS) labelDefaultOption(id, `Default (${label})`);
    }
    if (result.permissionMode) {
      const label = PERMISSION_DEFAULT_LABELS[result.permissionMode] || result.permissionMode;
      for (const id of PERMISSION_SELECT_IDS) labelDefaultOption(id, `Default (${label})`);
    }
  }

  // Merged into a POST body — only non-empty ("default") values are included.
  function currentModelAndPermissionFields() {
    const fields = {};
    const model = readModelPref();
    const permissionMode = readPermissionPref();
    if (model) fields.model = model;
    if (permissionMode) fields.permissionMode = permissionMode;
    return fields;
  }

  async function sendDetailMessage(message) {
    if (!state.activeDetailId) return;
    if (!message || !message.trim()) {
      showToast('Type a message before sending.');
      return;
    }
    const sessionId = state.activeDetailId;
    const workingEl = document.getElementById('chat-working');
    const workingText = document.getElementById('chat-working-text');
    if (workingText) workingText.textContent = `${assistantName()} is working…`;
    if (workingEl) workingEl.hidden = false;

    try {
      await fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, ...currentModelAndPermissionFields() }),
      });
      await loadSessions();
      if (state.activeDetailId === sessionId) await loadChatMessages(sessionId);
    } catch (err) {
      const errorMessage = err && err.message ? err.message : 'Failed to send the message';
      console.error('Failed to send message to session', err);
      showToast(errorMessage);
    } finally {
      if (workingEl) workingEl.hidden = true;
    }
  }

  // ---------- slash-command autocomplete ----------
  //
  // Detail composer only — it needs the open session's project path, which
  // only the drawer's "open session" concept has (the new-session command
  // bar has a chosen directory, not a session). Commands are cached per
  // project path so retyping "/" doesn't refetch on every keystroke; a
  // fetch failure is treated as "no commands available", not fatal.

  const SLASH_TRIGGER_RE = /(?:^|\s)\/(\S*)$/;
  const commandsCache = new Map(); // normalized project path -> Promise<Array<{name, description, source}>>

  function fetchCommandsForPath(projectPath) {
    const key = normalizeClientPath(projectPath);
    if (commandsCache.has(key)) return commandsCache.get(key);
    const promise = fetchJson(`/api/commands?path=${encodeURIComponent(projectPath)}`)
      .then((r) => (r && Array.isArray(r.commands) ? r.commands : []))
      .catch(() => []);
    commandsCache.set(key, promise);
    return promise;
  }

  const slashState = {
    open: false,
    items: [],
    activeIndex: 0,
    matchStart: -1, // index into the input value where the "/" itself starts
  };

  function closeSlashPopup() {
    slashState.open = false;
    slashState.items = [];
    const popup = document.getElementById('slash-popup');
    if (popup) {
      popup.hidden = true;
      popup.textContent = '';
    }
  }

  function renderSlashPopup() {
    const popup = document.getElementById('slash-popup');
    if (!popup) return;
    popup.textContent = '';
    if (slashState.items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'slash-popup-empty';
      empty.textContent = 'No matching commands';
      popup.appendChild(empty);
      popup.hidden = false;
      return;
    }
    slashState.items.forEach((cmd, idx) => {
      const row = document.createElement('div');
      row.className = `slash-popup-item${idx === slashState.activeIndex ? ' slash-popup-item--active' : ''}`;
      const name = document.createElement('div');
      name.className = 'slash-popup-item-name';
      name.textContent = cmd.name; // untrusted (project-authored) — textContent only
      row.appendChild(name);
      if (cmd.description) {
        const desc = document.createElement('div');
        desc.className = 'slash-popup-item-desc';
        desc.textContent = cmd.description; // untrusted — textContent only
        row.appendChild(desc);
      }
      // mousedown (not click) fires before the input would blur the popup away.
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        applySlashSelection(idx);
      });
      popup.appendChild(row);
    });
    popup.hidden = false;
  }

  function applySlashSelection(idx) {
    const cmd = slashState.items[idx];
    const input = document.getElementById('detail-send-input');
    if (!cmd || !input) return;
    const value = input.value;
    const cursor = input.selectionStart != null ? input.selectionStart : value.length;
    const before = value.slice(0, slashState.matchStart);
    const after = value.slice(cursor);
    const inserted = `/${cmd.name} `;
    input.value = before + inserted + after;
    const newCursor = (before + inserted).length;
    input.setSelectionRange(newCursor, newCursor);
    input.focus();
    closeSlashPopup();
  }

  function moveSlashActive(delta) {
    if (slashState.items.length === 0) return;
    slashState.activeIndex = (slashState.activeIndex + delta + slashState.items.length) % slashState.items.length;
    renderSlashPopup();
  }

  async function handleDetailInputForSlash() {
    const input = document.getElementById('detail-send-input');
    if (!input || !state.activeDetailId) {
      closeSlashPopup();
      return;
    }
    const cursor = input.selectionStart != null ? input.selectionStart : input.value.length;
    const match = SLASH_TRIGGER_RE.exec(input.value.slice(0, cursor));
    if (!match) {
      closeSlashPopup();
      return;
    }
    slashState.open = true;
    slashState.matchStart = match.index + (match[0].length - match[1].length - 1);

    const session = state.sessions.find((s) => s.id === state.activeDetailId);
    const projectPath = session && session.projectPath;
    if (!projectPath) {
      closeSlashPopup();
      return;
    }

    const sessionAtFetch = state.activeDetailId;
    const commands = await fetchCommandsForPath(projectPath);
    // The user may have kept typing, moved the caret off the slash token, or
    // switched sessions entirely while this was in flight — re-check both.
    if (state.activeDetailId !== sessionAtFetch) return;
    const currentCursor = input.selectionStart != null ? input.selectionStart : input.value.length;
    const currentMatch = SLASH_TRIGGER_RE.exec(input.value.slice(0, currentCursor));
    if (!currentMatch) {
      closeSlashPopup();
      return;
    }

    const q = currentMatch[1].toLowerCase();
    const filtered = commands
      .filter((c) => c.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return aStarts !== bStarts ? aStarts - bStarts : a.name.localeCompare(b.name);
      });
    slashState.items = filtered.slice(0, 20);
    slashState.activeIndex = 0;
    renderSlashPopup();
  }

  // ---------- add-file button (detail composer only) ----------

  function insertTextAtCursor(input, text) {
    const start = input.selectionStart != null ? input.selectionStart : input.value.length;
    const end = input.selectionEnd != null ? input.selectionEnd : input.value.length;
    const value = input.value;
    input.value = value.slice(0, start) + text + value.slice(end);
    const cursor = start + text.length;
    input.setSelectionRange(cursor, cursor);
    input.focus();
  }

  async function browseForFile() {
    const result = await guarded(
      fetchJson('/api/directories/browse-file', { method: 'POST' }),
      'Failed to open the file picker'
    );
    if (result === null) return;
    if (!result.path) return; // user cancelled the native dialog
    const input = document.getElementById('detail-send-input');
    if (input) insertTextAtCursor(input, `@${result.path} `);
  }

  // ---------- MCP server status panel ----------
  //
  // `claude mcp list` live-checks each server over the network (~15s in
  // testing), so this only ever runs when the user clicks the button —
  // never on drawer open, never polled.

  function closeMcpPanel() {
    const panel = document.getElementById('mcp-panel');
    if (panel) panel.hidden = true;
  }

  async function checkMcpStatus() {
    const sessionId = state.activeDetailId;
    if (!sessionId) return;
    const session = state.sessions.find((s) => s.id === sessionId);
    const projectPath = session && session.projectPath;
    const panel = document.getElementById('mcp-panel');
    const body = document.getElementById('mcp-panel-body');
    if (!panel || !body) return;

    panel.hidden = false;
    body.innerHTML = '';
    if (!projectPath) {
      const err = document.createElement('div');
      err.className = 'mcp-panel-error';
      err.textContent = "Couldn't determine this session's project directory.";
      body.appendChild(err);
      return;
    }

    const loading = document.createElement('div');
    loading.className = 'mcp-panel-loading';
    loading.textContent = 'Checking MCP server status… this can take up to 15s.';
    body.appendChild(loading);

    const result = await guarded(
      fetchJson(`/api/mcp/status?cwd=${encodeURIComponent(projectPath)}`),
      'Failed to check MCP server status'
    );
    // The user may have closed the panel or switched sessions while this was in flight.
    if (panel.hidden || state.activeDetailId !== sessionId) return;

    body.innerHTML = '';
    if (result === null) {
      const err = document.createElement('div');
      err.className = 'mcp-panel-error';
      err.textContent = 'Failed to check MCP server status.';
      body.appendChild(err);
      return;
    }

    const servers = result.servers || [];
    if (servers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'mcp-panel-empty';
      empty.textContent = 'No MCP servers configured for this project.';
      body.appendChild(empty);
      return;
    }

    for (const server of servers) {
      const row = document.createElement('div');
      row.className = 'mcp-server-row';

      const info = document.createElement('div');
      info.className = 'mcp-server-info';
      const name = document.createElement('div');
      name.className = 'mcp-server-name';
      name.textContent = server.name;
      const target = document.createElement('div');
      target.className = 'mcp-server-target';
      target.textContent = server.target;
      target.title = server.target;
      info.appendChild(name);
      info.appendChild(target);

      const badge = document.createElement('span');
      badge.className = `mcp-status-badge mcp-status-badge--${server.status}`;
      badge.textContent = server.statusText || server.status;

      row.appendChild(info);
      row.appendChild(badge);
      body.appendChild(row);
    }
  }

  // ---------- quick switcher (Cmd/Ctrl+K) ----------
  //
  // A minimal filter-and-jump tool over the session list already loaded into
  // state.sessions — no server round-trip. Matches title and project name,
  // case-insensitive substring. Enter/click on a result reuses openDetail(),
  // the same function the session cards call, so there's exactly one place
  // that opens the drawer.

  const QUICK_SWITCHER_LIMIT = 30;

  const quickSwitcherState = {
    items: [],
    activeIndex: 0,
  };

  function quickSwitcherMatches(query) {
    const q = query.trim().toLowerCase();
    const pool = q
      ? state.sessions.filter((s) => {
          const title = (s.title || '').toLowerCase();
          const project = (s.projectName || s.projectFolder || '').toLowerCase();
          return title.includes(q) || project.includes(q);
        })
      : state.sessions;
    return pool.slice(0, QUICK_SWITCHER_LIMIT);
  }

  function renderQuickSwitcherResults() {
    const list = document.getElementById('quick-switcher-results');
    if (!list) return;
    list.textContent = '';

    if (quickSwitcherState.items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'quick-switcher-empty';
      empty.textContent = 'No matching sessions';
      list.appendChild(empty);
      return;
    }

    quickSwitcherState.items.forEach((session, idx) => {
      const row = document.createElement('div');
      row.className = `quick-switcher-item${idx === quickSwitcherState.activeIndex ? ' quick-switcher-item--active' : ''}`;

      const titleRow = document.createElement('div');
      titleRow.className = 'quick-switcher-item-title';
      const dot = document.createElement('span');
      dot.className = `quick-switcher-item-status${session.isRunning ? ' quick-switcher-item-status--running' : ''}`;
      titleRow.appendChild(dot);
      // Session title is user-supplied — a plain text node, never innerHTML.
      titleRow.appendChild(document.createTextNode(session.title || '(no summary yet)'));

      const meta = document.createElement('div');
      meta.className = 'quick-switcher-item-meta';
      meta.textContent = `${session.projectName || session.projectFolder}${session.gitBranch ? ' · ' + session.gitBranch : ''}`;

      row.appendChild(titleRow);
      row.appendChild(meta);
      // mousedown (not click) fires before the input would blur the popup away.
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        selectQuickSwitcherItem(idx);
      });
      list.appendChild(row);
    });
  }

  function openQuickSwitcher() {
    const overlay = document.getElementById('quick-switcher-overlay');
    const input = document.getElementById('quick-switcher-input');
    if (!overlay || !input) return;
    overlay.hidden = false;
    input.value = '';
    quickSwitcherState.items = quickSwitcherMatches('');
    quickSwitcherState.activeIndex = 0;
    renderQuickSwitcherResults();
    // The overlay was just un-hidden; focus on the next tick so it reliably lands.
    setTimeout(() => input.focus(), 0);
  }

  function closeQuickSwitcher() {
    const overlay = document.getElementById('quick-switcher-overlay');
    if (overlay) overlay.hidden = true;
  }

  function isQuickSwitcherOpen() {
    const overlay = document.getElementById('quick-switcher-overlay');
    return !!overlay && !overlay.hidden;
  }

  function moveQuickSwitcherActive(delta) {
    if (quickSwitcherState.items.length === 0) return;
    const n = quickSwitcherState.items.length;
    quickSwitcherState.activeIndex = (quickSwitcherState.activeIndex + delta + n) % n;
    renderQuickSwitcherResults();
  }

  function selectQuickSwitcherItem(idx) {
    const session = quickSwitcherState.items[idx];
    if (!session) return;
    closeQuickSwitcher();
    openDetail(session.id); // same function the session cards use
  }

  function wireQuickSwitcher() {
    const input = document.getElementById('quick-switcher-input');
    const overlay = document.getElementById('quick-switcher-overlay');
    if (!input || !overlay) return;

    input.addEventListener('input', () => {
      quickSwitcherState.items = quickSwitcherMatches(input.value);
      quickSwitcherState.activeIndex = 0;
      renderQuickSwitcherResults();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveQuickSwitcherActive(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveQuickSwitcherActive(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); selectQuickSwitcherItem(quickSwitcherState.activeIndex); }
      // Escape is handled by the document-level handler below.
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeQuickSwitcher();
    });
    document.addEventListener('keydown', (e) => {
      const key = e.key ? e.key.toLowerCase() : '';
      if ((e.metaKey || e.ctrlKey) && key === 'k') {
        e.preventDefault();
        openQuickSwitcher();
      }
    });
  }

  // ---------- new-session directory picker + command bar ----------

  function currentTargetDirectory() {
    return state.selectedDirectory || state.recentDirs[0] || (state.projects[0] && state.projects[0].projectPath) || null;
  }

  // The same picker is offered in two places — the header's "+ New session"
  // button and the command bar's directory chip — so both menus are driven
  // from one list of directories and one selection function.
  const DIR_MENUS = [
    { menu: 'new-session-menu', list: 'recent-directories-list' },
    { menu: 'command-dir-menu', list: 'command-recent-directories-list' },
  ];

  function basenameOf(dirPath) {
    // Paths arrive with either separator depending on where they were recorded.
    const parts = String(dirPath).replace(/[\\/]+$/, '').split(/[\\/]/);
    return parts[parts.length - 1] || dirPath;
  }

  function updateCommandBarHint() {
    const hint = document.querySelector('.command-bar-hint-text');
    if (hint) {
      hint.textContent = `issue a command — ${assistantName()} will run it in the directory you choose`;
    }
    updateDirChip();
  }

  function updateDirChip() {
    const name = document.getElementById('command-dir-chip-name');
    const chip = document.getElementById('command-dir-chip');
    if (!name || !chip) return;
    const dir = currentTargetDirectory();
    // The chip shows the folder name so it stays readable; the full path is
    // still one hover away, because two repos can share a basename.
    name.textContent = dir ? basenameOf(dir) : 'choose a directory';
    chip.title = dir ? dir : 'Choose which directory the agent runs in';
    chip.classList.toggle('dir-chip--empty', !dir);
  }

  function closeDirectoryMenus() {
    for (const { menu } of DIR_MENUS) {
      const el = document.getElementById(menu);
      if (el) el.hidden = true;
    }
  }

  function toggleDirectoryMenu(menuId) {
    const menu = document.getElementById(menuId);
    if (!menu) return;
    const wasHidden = menu.hidden;
    closeDirectoryMenus();
    menu.hidden = !wasHidden;
  }

  function selectDirectory(dir) {
    state.selectedDirectory = dir;
    updateCommandBarHint();
    closeDirectoryMenus();
    highlightSelectedDirectory(dir);
  }

  function highlightSelectedDirectory(dir) {
    for (const { list } of DIR_MENUS) {
      const el = document.getElementById(list);
      if (!el) continue;
      for (const item of el.children) {
        item.style.background = item.dataset.dir === dir ? 'var(--accent-soft)' : '';
      }
    }
  }

  function renderDirectoryList(listEl) {
    listEl.textContent = '';
    for (const dir of state.recentDirs) {
      const item = document.createElement('div');
      item.className = 'menu-item';
      item.dataset.dir = dir;
      // Static markup only — the path itself goes in via textContent below.
      item.innerHTML = `<span class="status-dot dir-status-dot"></span><span class="dir-path mono"></span>`;
      item.querySelector('.dir-path').textContent = dir;
      item.addEventListener('click', () => selectDirectory(dir));
      listEl.appendChild(item);
    }
  }

  async function loadRecentDirectories() {
    const dirs = await guarded(fetchJson('/api/directories/recent'), 'Failed to load recent directories');
    if (dirs === null) return;
    state.recentDirs = dirs;
    for (const { list } of DIR_MENUS) {
      const el = document.getElementById(list);
      if (el) renderDirectoryList(el);
    }
    highlightSelectedDirectory(currentTargetDirectory());
    updateCommandBarHint();
  }

  async function browseForDirectory() {
    const result = await guarded(
      fetchJson('/api/directories/browse', { method: 'POST' }),
      'Failed to open the folder picker'
    );
    if (result === null) return;
    if (!result.path) return; // user cancelled the native dialog
    selectDirectory(result.path);
    await loadRecentDirectories();
    // loadRecentDirectories rebuilds the list and clears selection highlighting;
    // restore the just-picked directory as the active selection.
    state.selectedDirectory = result.path;
    updateCommandBarHint();
  }

  async function startNewSession(cwd) {
    const input = document.getElementById('command-input');
    const message = input.value.trim();
    if (!message) {
      showToast('Type a message before sending.');
      input.focus();
      return;
    }
    if (!cwd) {
      showToast('Pick a directory first — use the folder chip next to the command box.');
      toggleDirectoryMenu('command-dir-menu');
      return;
    }
    showToast(`${assistantName()} is on it…`, false);
    const priorIds = new Set(state.sessions.map((s) => s.id));
    const result = await guarded(
      fetchJson('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, message, ...currentModelAndPermissionFields() }),
      }),
      'Failed to start session'
    );
    if (result === null) return;
    input.value = '';
    showToast(`${assistantName()} finished the run — session added.`, false);
    await Promise.all([loadSessions(), loadProjects(), loadRecentDirectories()]);
    // This browser just created that session — it shouldn't show as unseen.
    markSessionsSeenSince(priorIds);
  }

  // ---------- WebSocket ----------

  let wsConnection = null;

  function sendWsMessage(obj) {
    if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
      wsConnection.send(JSON.stringify(obj));
    }
  }

  function connectWebSocket() {
    const scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const ws = new WebSocket(`${scheme}${location.host}`);
    wsConnection = ws;
    ws.addEventListener('open', () => {
      // Server-side watches die with the old connection — re-establish for
      // whichever chat is open.
      if (state.activeDetailId) watchSession(state.activeDetailId);
    });
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'session-status') {
        loadSessions();
      } else if (msg.type === 'transcript-update' && msg.sessionId === state.activeDetailId) {
        loadChatMessages(msg.sessionId);
      }
    });
    ws.addEventListener('close', () => {
      setTimeout(connectWebSocket, 3000);
    });
    ws.addEventListener('error', () => {
      ws.close();
    });
  }

  // ---------- memory ----------

  // Supplements (does not replace) the existing toast: a small inline label
  // next to each save button that tracks the textarea's dirty state across
  // load/edit/save, so "did my last edit actually save?" doesn't require
  // remembering whether a toast flashed by a moment ago.
  function setMemoryStatus(elId, text, cls) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.textContent = text;
    el.classList.remove('memory-status--unsaved', 'memory-status--saved');
    if (cls) el.classList.add(cls);
  }

  function wireMemoryStatus() {
    const commonTextarea = document.getElementById('memory-common-text');
    if (commonTextarea) {
      commonTextarea.addEventListener('input', () =>
        setMemoryStatus('memory-common-status', 'Unsaved changes', 'memory-status--unsaved'));
    }
    const projectTextarea = document.getElementById('memory-project-text');
    if (projectTextarea) {
      projectTextarea.addEventListener('input', () =>
        setMemoryStatus('memory-project-status', 'Unsaved changes', 'memory-status--unsaved'));
    }
  }

  async function loadMemoryCommon() {
    const result = await guarded(fetchJson('/api/memory/common'), 'Failed to load common memory');
    if (result === null) return;
    document.getElementById('memory-common-text').value = result.text || '';
    setMemoryStatus('memory-common-status', '', null);
  }

  async function saveMemoryCommon() {
    const text = document.getElementById('memory-common-text').value;
    const result = await guarded(
      fetchJson('/api/memory/common', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      }),
      'Failed to save common memory'
    );
    if (result !== null) {
      showToast('Common memory saved.', false);
      setMemoryStatus('memory-common-status', `Saved at ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, 'memory-status--saved');
    }
  }

  async function loadMemoryProject(projectPath) {
    const textarea = document.getElementById('memory-project-text');
    if (!projectPath) {
      textarea.value = '';
      setMemoryStatus('memory-project-status', '', null);
      return;
    }
    const result = await guarded(
      fetchJson(`/api/memory/project?path=${encodeURIComponent(projectPath)}`),
      'Failed to load project memory'
    );
    if (result === null) return;
    textarea.value = result.text || '';
    setMemoryStatus('memory-project-status', '', null);
  }

  async function saveMemoryProject() {
    const select = document.getElementById('memory-project-select');
    const text = document.getElementById('memory-project-text').value;
    if (!select.value) {
      showToast('Select a project before saving project memory.');
      return;
    }
    const result = await guarded(
      fetchJson('/api/memory/project', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: select.value, text }),
      }),
      'Failed to save project memory'
    );
    if (result !== null) {
      showToast('Project memory saved.', false);
      setMemoryStatus('memory-project-status', `Saved at ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, 'memory-status--saved');
    }
  }

  function populateMemoryProjectSelect() {
    const select = document.getElementById('memory-project-select');
    const previous = select.value;
    select.innerHTML = '<option value="">Select a project…</option>';
    for (const project of trackedProjects()) {
      const option = document.createElement('option');
      option.value = project.projectPath;
      option.textContent = project.projectName || project.projectFolder;
      select.appendChild(option);
    }
    if (previous && state.projects.some((p) => p.projectPath === previous)) {
      select.value = previous;
    }
  }

  // ---------- periodic refresh (sessions started outside the dashboard,
  // e.g. from a terminal, produce no WebSocket event, so the grid needs to
  // poll on its own or it goes stale forever) ----------

  const REFRESH_INTERVAL_MS = 10000;
  let refreshInFlight = false;
  let refreshTimerId = null;

  async function refreshData() {
    if (refreshInFlight) return; // don't stack overlapping requests
    refreshInFlight = true;
    try {
      // loadSessions/loadProjects use the existing incremental render paths,
      // so the one-time card-in animation does not replay on poll.
      await Promise.all([loadSessions(), loadProjects()]);
    } finally {
      refreshInFlight = false;
    }
  }

  function startAutoRefresh() {
    if (refreshTimerId) return;
    refreshTimerId = setInterval(refreshData, REFRESH_INTERVAL_MS);
  }

  function stopAutoRefresh() {
    if (refreshTimerId) {
      clearInterval(refreshTimerId);
      refreshTimerId = null;
    }
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      stopAutoRefresh();
    } else {
      startAutoRefresh();
      refreshData();
    }
  }

  // ---------- header stats ----------

  function updateHeaderStats() {
    const sessionRunningCount = state.sessions.filter((s) => s.isRunning).length;
    // Dashboard-started runs are tracked under a synthetic id until the
    // transcript file lands, so they never match a real session's id and
    // never flip that session's isRunning to true. Fall back to the max
    // with the server's live active-run count so those runs are still
    // reflected here.
    const runningCount = Math.max(sessionRunningCount, state.activeCount || 0);
    const runningEl = document.getElementById('running-count-value');
    if (runningEl) runningEl.textContent = String(runningCount);

    const allCountEl = document.getElementById('all-sessions-count');
    if (allCountEl) allCountEl.textContent = String(state.sessions.length);

    // All-time cost the claude CLI has reported across every call this
    // dashboard has made — a running total, not an account-level quota or
    // rate-limit reading (the CLI exposes no such thing).
    const usageAllTimeEl = document.getElementById('usage-alltime-value');
    if (usageAllTimeEl) {
      const allTime = (state.usage && state.usage.allTime) || {};
      usageAllTimeEl.textContent = formatCurrency(allTime.costUsd);
    }

    const subEl = document.getElementById('section-header-sub');
    if (subEl) {
      const repoCount = trackedProjects().length;
      subEl.textContent = `${runningCount} agent${runningCount === 1 ? '' : 's'} active across ${repoCount} repo${repoCount === 1 ? '' : 's'}`;
    }

    // The header and hero orbs are the global activity indicators: they
    // breathe when idle and pulse faster while anything runs.
    for (const orbId of ['header-orb', 'hero-orb']) {
      const orb = document.getElementById(orbId);
      if (orb) orb.classList.toggle('orb--active', runningCount > 0);
    }

    // Quiet hint on the Projects button when discovered projects are hidden.
    const hintEl = document.getElementById('untracked-hint');
    if (hintEl && state.settings) {
      const untracked = state.projects.filter((p) => !isTrackedPath(p.projectPath)).length;
      hintEl.textContent = untracked > 0 ? `+${untracked}` : '';
    }
  }

  // ---------- sidebar view switching (All sessions <-> Memory) ----------

  function mainViewSections() {
    return [
      document.querySelector('.hero-orb-wrap'),
      document.querySelector('.command-bar'),
      document.querySelector('.section-header'),
      // The whole controls row, not just its eyebrow: the sort and filter
      // buttons live in here too and have no meaning in the Memory view.
      document.querySelector('.sessions-controls'),
      document.getElementById('session-grid'),
      document.getElementById('session-more-row'),
      document.querySelector('.section-label-row'),
      document.querySelector('.backlog-add-row'),
      document.getElementById('backlog-list'),
    ].filter(Boolean);
  }

  function showSessionsView() {
    for (const el of mainViewSections()) el.style.display = '';
    // The Load more row owns its own display (it's hidden once everything is
    // shown), so blanket-restoring above would resurrect a stale button.
    renderSessionControls();
    document.getElementById('memory-panel').style.display = 'none';
    document.getElementById('all-sessions-row').classList.add('row--active');
    document.getElementById('memory-row').classList.remove('row--active');
  }

  function showMemoryView() {
    for (const el of mainViewSections()) el.style.display = 'none';
    document.getElementById('memory-panel').style.display = 'block';
    document.getElementById('memory-row').classList.add('row--active');
    document.getElementById('all-sessions-row').classList.remove('row--active');
  }

  // ---------- the living orb ----------
  //
  // The orb itself is pure CSS (layered radial gradients, a drifting conic
  // rim highlight, breathe/burst keyframes in styles.css) — no canvas, no
  // per-frame JS. `.orb--active` (any session running) speeds it up and
  // brightens it; `.orb--burst` (naming celebration) fires a one-shot pop.
  // The only scripted part is the hero orb's scroll collapse below.

  // The hero orb is a nice first impression and dead weight thereafter, so it
  // folds away once you start reading the list below it.
  function initHeroOrb() {
    const wrap = document.getElementById('hero-orb-wrap');
    const scroller = document.getElementById('main-content');
    if (!wrap) return;

    // Which element actually scrolls depends on how tall the content is:
    // .app-shell is only min-height-capped, so with a short session list the
    // whole document scrolls and .main-content never overflows, while with a
    // long list .main-content takes over. Watch both and use whichever moved.
    const offset = () => Math.max(
      scroller ? scroller.scrollTop : 0,
      window.pageYOffset || document.documentElement.scrollTop || 0
    );

    // Hysteresis: collapse past 80px, expand only back under 30px. A single
    // threshold makes the hero flap open and shut when you rest mid-scroll.
    let collapsed = false;
    let lastAt = 0;
    // Throttle on a timestamp rather than coalescing into requestAnimationFrame:
    // some embedded webviews report the document as permanently hidden and never
    // fire rAF at all (see the watchdog in initOrbs), which would leave the hero
    // stuck open forever. ~60ms is well under the transition duration, so this
    // still feels immediate, and scrollTop is the only layout read per call.
    const onScroll = () => {
      const t = performance.now();
      if (t - lastAt < 60) return;
      lastAt = t;
      const y = offset();
      if (!collapsed && y > 80) collapsed = true;
      else if (collapsed && y < 30) collapsed = false;
      else return;
      wrap.classList.toggle('is-collapsed', collapsed);
    };
    if (scroller) scroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  // ---------- settings, onboarding & project picker ----------

  async function saveSettings(patch) {
    const updated = await guarded(
      fetchJson('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }),
      'Failed to save settings'
    );
    if (updated !== null) {
      state.settings = updated;
      applyAssistantName();
    }
    return updated;
  }

  async function initSettings() {
    const settings = await guarded(fetchJson('/api/settings'), 'Failed to load settings');
    state.settings = settings || { assistantName: null, onboardedAt: null, projects: [] };
    applyAssistantName();
    if (!state.settings.assistantName) openOnboarding();
  }

  // Paths typed into the "add another path" inputs, per picker instance.
  const pickerAdded = { onboarding: [], modal: [] };

  // Renders a checkable project list into `containerId`. Entries come from
  // discovered projects (~/.claude/projects), currently tracked paths that
  // were never discovered, and paths the user typed this visit.
  function renderProjectPicker(containerId, addedKey, checkedPaths) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    const checked = new Set(checkedPaths.map(normalizeClientPath));
    const entries = [];
    const seen = new Set();

    for (const p of state.projects) {
      if (!p.projectPath) continue;
      entries.push({ path: p.projectPath, name: p.projectName || p.projectFolder, count: p.sessionCount });
      seen.add(normalizeClientPath(p.projectPath));
    }
    for (const p of checkedPaths) {
      if (!seen.has(normalizeClientPath(p))) {
        entries.push({ path: p, name: lastPathSegment(p), count: null });
        seen.add(normalizeClientPath(p));
      }
    }
    for (const p of pickerAdded[addedKey]) {
      if (!seen.has(normalizeClientPath(p))) {
        entries.push({ path: p, name: lastPathSegment(p), count: null });
        seen.add(normalizeClientPath(p));
      }
    }

    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'project-picker-empty';
      empty.textContent = 'No projects found yet — add a path below, or skip and start a session later.';
      container.appendChild(empty);
      return;
    }

    for (const entry of entries) {
      const row = document.createElement('label');
      row.className = 'project-picker-row';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'project-picker-checkbox';
      checkbox.checked = checked.has(normalizeClientPath(entry.path));
      checkbox.dataset.path = entry.path;
      const info = document.createElement('div');
      info.className = 'project-picker-info';
      const name = document.createElement('div');
      name.className = 'project-picker-name';
      name.textContent = entry.name;
      const path = document.createElement('div');
      path.className = 'project-picker-path';
      path.textContent = entry.path;
      info.appendChild(name);
      info.appendChild(path);
      row.appendChild(checkbox);
      row.appendChild(info);
      if (entry.count !== null && entry.count !== undefined) {
        const count = document.createElement('div');
        count.className = 'project-picker-count';
        count.textContent = `${entry.count} session${entry.count === 1 ? '' : 's'}`;
        row.appendChild(count);
      }
      container.appendChild(row);
    }
  }

  function collectPickerSelection(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return [];
    return Array.from(container.querySelectorAll('.project-picker-checkbox'))
      .filter((cb) => cb.checked)
      .map((cb) => cb.dataset.path);
  }

  function addPickerPath(inputId, containerId, addedKey, checkedPathsFn) {
    const input = document.getElementById(inputId);
    const value = input.value.trim();
    if (!value) return;
    pickerAdded[addedKey].push(value);
    input.value = '';
    // Preserve what's already checked, and check the new path.
    const current = collectPickerSelection(containerId);
    renderProjectPicker(containerId, addedKey, [...checkedPathsFn(), ...current, value]);
  }

  // -- onboarding flow --

  function openOnboarding() {
    document.getElementById('onboarding-overlay').hidden = false;
    document.getElementById('onboarding-step-name').hidden = false;
    document.getElementById('onboarding-step-projects').hidden = true;
    const input = document.getElementById('onboarding-name-input');
    setTimeout(() => input.focus(), 50);
  }

  async function confirmOnboardingName() {
    const input = document.getElementById('onboarding-name-input');
    const name = input.value.trim();
    if (!name) {
      showToast('Give your assistant a name first.');
      input.focus();
      return;
    }
    const saved = await saveSettings({ assistantName: name });
    if (saved === null) return;
    // Pulse-burst, then advance to the project picker.
    document.getElementById('onboarding-orb').classList.add('orb--burst');
    const projects = await guarded(fetchJson('/api/projects'), 'Failed to discover projects');
    if (projects !== null) state.projects = projects;
    setTimeout(() => {
      document.getElementById('onboarding-step-name').hidden = true;
      document.getElementById('onboarding-step-projects').hidden = false;
      const titleEl = document.getElementById('onboarding-projects-title');
      titleEl.textContent = `Which projects should ${name} watch?`;
      pickerAdded.onboarding = [];
      renderProjectPicker('onboarding-project-list', 'onboarding', []);
    }, 700);
  }

  async function finishOnboarding(skip) {
    if (!skip) {
      const selection = collectPickerSelection('onboarding-project-list');
      const saved = await saveSettings({ projects: selection });
      if (saved === null) return;
    }
    document.getElementById('onboarding-overlay').hidden = true;
    await Promise.all([loadSessions(), loadProjects(), loadBacklog()]);
  }

  // -- projects modal --

  function openProjectsModal() {
    pickerAdded.modal = [];
    renderProjectPicker('projects-modal-list', 'modal', (state.settings && state.settings.projects) || []);
    document.getElementById('projects-modal').hidden = false;
  }

  function closeProjectsModal() {
    document.getElementById('projects-modal').hidden = true;
  }

  async function saveProjectsModal() {
    const selection = collectPickerSelection('projects-modal-list');
    const saved = await saveSettings({ projects: selection });
    if (saved === null) return;
    closeProjectsModal();
    showToast('Tracked projects updated.', false);
    await Promise.all([loadSessions(), loadProjects(), loadBacklog()]);
  }

  // -- header rename --

  function startHeaderRename() {
    const titleEl = document.getElementById('header-assistant-name');
    if (!titleEl || titleEl.style.display === 'none') return;
    const input = document.createElement('input');
    input.className = 'header-rename-input';
    input.value = (state.settings && state.settings.assistantName) || '';
    input.maxLength = 24;
    titleEl.style.display = 'none';
    titleEl.parentNode.insertBefore(input, titleEl.nextSibling);
    input.focus();
    input.select();

    let finished = false;
    async function finish(commit) {
      if (finished) return;
      finished = true;
      const name = input.value.trim();
      input.remove();
      titleEl.style.display = '';
      if (commit && name && name !== (state.settings && state.settings.assistantName)) {
        const saved = await saveSettings({ assistantName: name });
        if (saved !== null) showToast(`Renamed to ${saved.assistantName}.`, false);
      }
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  // ---------- wiring ----------

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('new-session-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDirectoryMenu('new-session-menu');
    });
    document.getElementById('command-dir-chip').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDirectoryMenu('command-dir-menu');
    });
    document.addEventListener('click', (e) => {
      // Close the pickers on any click outside of either of their anchors.
      const inAnchor = e.target.closest('.new-session-wrap, .dir-chip-wrap');
      if (!inAnchor) closeDirectoryMenus();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (isQuickSwitcherOpen()) { closeQuickSwitcher(); return; }
        closeDirectoryMenus();
        closeProjectsModal();
        closeDetail();
      }
    });

    wireSessionControls();
    wireQuickSwitcher();

    document.getElementById('browse-directory-btn').addEventListener('click', browseForDirectory);
    document.getElementById('command-browse-directory-btn').addEventListener('click', browseForDirectory);
    document.getElementById('command-send-btn').addEventListener('click', () => {
      startNewSession(currentTargetDirectory());
    });
    document.getElementById('command-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') startNewSession(currentTargetDirectory());
    });

    document.getElementById('backlog-add-btn').addEventListener('click', () => {
      const input = document.getElementById('backlog-input');
      addBacklogItem(input.value.trim(), currentTargetDirectory()).then(() => {
        if (input.value) input.value = '';
      });
    });
    document.getElementById('backlog-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('backlog-add-btn').click();
    });

    document.getElementById('memory-common-save').addEventListener('click', saveMemoryCommon);
    document.getElementById('memory-project-save').addEventListener('click', saveMemoryProject);
    document.getElementById('memory-project-select').addEventListener('change', (e) => loadMemoryProject(e.target.value));
    wireMemoryStatus();

    document.getElementById('all-sessions-row').addEventListener('click', showSessionsView);
    document.getElementById('memory-row').addEventListener('click', showMemoryView);

    // onboarding
    document.getElementById('onboarding-name-confirm').addEventListener('click', confirmOnboardingName);
    document.getElementById('onboarding-name-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirmOnboardingName();
    });
    document.getElementById('onboarding-add-btn').addEventListener('click', () => {
      addPickerPath('onboarding-add-path', 'onboarding-project-list', 'onboarding', () => []);
    });
    document.getElementById('onboarding-add-path').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('onboarding-add-btn').click();
    });
    document.getElementById('onboarding-skip').addEventListener('click', () => finishOnboarding(true));
    document.getElementById('onboarding-finish').addEventListener('click', () => finishOnboarding(false));

    // projects modal
    document.getElementById('projects-btn').addEventListener('click', openProjectsModal);
    document.getElementById('projects-modal-close').addEventListener('click', closeProjectsModal);
    document.getElementById('projects-modal').addEventListener('click', (e) => {
      if (e.target === document.getElementById('projects-modal')) closeProjectsModal();
    });
    document.getElementById('projects-modal-add-btn').addEventListener('click', () => {
      addPickerPath('projects-modal-add-path', 'projects-modal-list', 'modal',
        () => (state.settings && state.settings.projects) || []);
    });
    document.getElementById('projects-modal-add-path').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('projects-modal-add-btn').click();
    });
    document.getElementById('projects-modal-save').addEventListener('click', saveProjectsModal);

    // rename
    document.getElementById('header-assistant-name').addEventListener('click', startHeaderRename);

    document.getElementById('detail-close-btn').addEventListener('click', closeDetail);
    document.getElementById('detail-cancel-btn').addEventListener('click', cancelRunningSession);
    document.getElementById('detail-size-btn').addEventListener('click', cycleDrawerSize);
    document.getElementById('detail-minimize-btn').addEventListener('click', toggleDrawerMinimized);
    // A minimized drawer is mostly header, so let the header itself restore it.
    document.querySelector('#detail-drawer .drawer-header').addEventListener('click', (e) => {
      if (state.drawerMinimized && !e.target.closest('.drawer-controls')) toggleDrawerMinimized();
    });
    wireDrawerResize();

    const detailInput = document.querySelector('#detail-drawer .detail-send-input');
    const detailSendBtn = document.querySelector('#detail-drawer .detail-send-btn');
    detailSendBtn.addEventListener('click', () => {
      sendDetailMessage(detailInput.value);
      detailInput.value = '';
      closeSlashPopup();
    });
    detailInput.addEventListener('keydown', (e) => {
      if (slashState.open) {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveSlashActive(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); moveSlashActive(-1); return; }
        if ((e.key === 'Enter' || e.key === 'Tab') && slashState.items.length > 0) {
          e.preventDefault();
          applySlashSelection(slashState.activeIndex);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          closeSlashPopup();
          return;
        }
      }
      if (e.key === 'Enter') detailSendBtn.click();
    });
    detailInput.addEventListener('input', handleDetailInputForSlash);
    detailInput.addEventListener('click', handleDetailInputForSlash);
    detailInput.addEventListener('blur', () => closeSlashPopup());

    document.getElementById('detail-attach-btn').addEventListener('click', browseForFile);
    document.getElementById('detail-mcp-btn').addEventListener('click', () => {
      const panel = document.getElementById('mcp-panel');
      if (panel && !panel.hidden) { closeMcpPanel(); return; }
      checkMcpStatus();
    });
    document.getElementById('mcp-panel-close').addEventListener('click', closeMcpPanel);

    // Model / permission-mode selectors: same preference mirrored in both the
    // command bar and the drawer footer.
    applyControlPrefsToSelects();
    wireControlSelects();
    loadClaudeDefaultsLabel();

    initHeroOrb();

    // Settings must load first so the tracked-projects filter and the
    // assistant's name are in place before anything renders.
    (async () => {
      await initSettings();
      loadSessions();
      loadProjects();
      loadBacklog();
      loadRecentDirectories();
      loadMemoryCommon();
      connectWebSocket();
    })();

    document.addEventListener('visibilitychange', handleVisibilityChange);
    if (!document.hidden) startAutoRefresh();
  });
})();
