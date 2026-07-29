// public/app.js
(function () {
  const state = {
    sessions: [],
    projects: [],
    backlog: [],
    recentDirs: [],
    layout: layoutStore.createLayout(),
    selectedDirectory: null,
    activeCount: 0,
    settings: null,
  };

  const LAYOUT_KEY = 'djinn.layout';

  function focusedSessionId() {
    return state.layout.focusedId;
  }

  function openSessionIds() {
    return state.layout.panes.map((p) => p.sessionId);
  }

  function paneFor(sessionId) {
    return document.querySelector(`.pane[data-session-id="${CSS.escape(sessionId)}"]`);
  }

  function persistLayout() {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layoutStore.serialize(state.layout)));
    } catch { /* private mode / storage disabled — layout is a convenience */ }
  }

  // Applies a layout transition, re-renders, and persists in one place, so no
  // caller can update the model and forget to do the other two.
  function setLayout(next) {
    if (next === state.layout) return;
    state.layout = next;
    renderPanes();
    persistLayout();
  }

  // Provisional cap: Task 8 makes this width-aware.
  function currentPaneCap() {
    return layoutStore.MAX_PANES;
  }

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
    const [sessions, activeCountResult] = await Promise.all([
      guarded(fetchJson('/api/sessions'), 'Failed to load sessions'),
      guarded(fetchJson('/api/sessions/active-count'), 'Failed to load active session count'),
    ]);
    if (sessions === null) return;
    state.sessions = sessions;
    state.activeCount = activeCountResult ? activeCountResult.activeCount : 0;
    seedViewedBaseline();
    pruneDraftsForMissingSessions();
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
    populateBacklogFolderSelect();
    renderBacklog(); // re-render so each row's repo <select> reflects the now-loaded project list
    updateCommandBarHint();
  }

  async function loadBacklog() {
    const backlog = await guarded(fetchJson('/api/backlog'), 'Failed to load backlog');
    if (backlog === null) return;
    state.backlog = backlog;
    renderBacklog();
  }

  // 'needs-input' is still isRunning:true underneath — it's a running session
  // whose transcript has sat on an unresolved tool_use long enough (see
  // NEEDS_INPUT_STALE_MS in server/routes/sessions.js) that it reads as stuck
  // rather than merely mid-tool-call. Most likely cause: a permission prompt
  // this headless session has no way to answer, which otherwise hangs
  // forever looking identical to an idle, finished session.
  function statusOf(session) {
    if (!session.isRunning) return 'idle';
    return session.needsInput ? 'needs-input' : 'running';
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
        <div class="card-top-right">
          <button type="button" class="card-split-btn" title="Open in a new pane" aria-label="Open in a new pane">⊞</button>
          <span class="dotnum card-time"></span>
        </div>
      </div>
      <div class="card-title"></div>
      <div class="card-meta mono">
        <span class="card-meta-path"></span>
      </div>
    `;
    card.addEventListener('click', (e) => openDetail(session.id, e.shiftKey ? 'split' : 'replace'));
    card.querySelector('.card-split-btn').addEventListener('click', (e) => {
      e.stopPropagation(); // the card's own handler would replace instead
      openDetail(session.id, 'split');
    });
  }

  const STATUS_LABELS = { running: 'Running', 'needs-input': 'Needs input', idle: 'Idle' };

  function updateCardContent(card, session) {
    const status = statusOf(session);
    const dot = card.querySelector('.status-dot');
    // Still pulsing for needs-input — the process really is alive, just stuck
    // — the warn color is what signals "look at this", not a stopped animation.
    dot.classList.toggle('status-dot--pulse-fast', status === 'running' || status === 'needs-input');
    dot.classList.toggle('status-dot--needs-input', status === 'needs-input');

    const label = card.querySelector('.card-status-label');
    label.textContent = STATUS_LABELS[status];
    label.classList.toggle('card-status-label--running', status === 'running');
    label.classList.toggle('card-status-label--needs-input', status === 'needs-input');
    label.classList.toggle('card-status-label--done', status === 'idle');

    const unseenBadge = card.querySelector('.card-unseen-badge');
    if (unseenBadge) unseenBadge.classList.toggle('card-status-label--unseen', isSessionUnseen(session));

    card.querySelector('.card-time').textContent = formatRelativeTime(session.lastActivity);
    card.querySelector('.card-title').textContent = session.title || '(no summary yet)';
    card.querySelector('.card-meta-path').textContent =
      `${session.projectName || session.projectFolder}${session.gitBranch ? ' · ' + session.gitBranch : ''}`;

    card.classList.toggle('card--active', openSessionIds().includes(session.id));
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
          <select class="backlog-priority" title="Priority"></select>
          <select class="mono backlog-row-project" title="Repo"></select>
          <button type="button" class="backlog-assign-btn">Ship &rarr;</button>
          <button type="button" class="backlog-delete-btn" title="Remove from backlog">&times;</button>
        `;
        const checkbox = row.querySelector('.backlog-checkbox');
        checkbox.checked = !!item.done;
        checkbox.addEventListener('change', (e) => updateBacklogItemField(item.id, 'done', e.target.checked));

        const titleEl = row.querySelector('.backlog-row-title');
        titleEl.textContent = item.title;
        if (item.done) titleEl.style.textDecoration = 'line-through';

        const priorityEl = row.querySelector('.backlog-priority');
        for (const p of ['low', 'medium', 'high']) {
          const opt = document.createElement('option');
          opt.value = p;
          opt.textContent = p;
          if (p === priority) opt.selected = true;
          priorityEl.appendChild(opt);
        }
        priorityEl.classList.add(`backlog-priority--${priority}`);
        priorityEl.addEventListener('change', (e) => {
          priorityEl.classList.remove('backlog-priority--low', 'backlog-priority--medium', 'backlog-priority--high');
          priorityEl.classList.add(`backlog-priority--${e.target.value}`);
          updateBacklogItemField(item.id, 'priority', e.target.value);
        });

        const projectEl = row.querySelector('.backlog-row-project');
        for (const project of trackedProjects()) {
          const opt = document.createElement('option');
          opt.value = project.projectPath;
          opt.textContent = project.projectName || project.projectFolder;
          if (normalizeClientPath(project.projectPath) === normalizeClientPath(item.repoPath)) opt.selected = true;
          projectEl.appendChild(opt);
        }
        projectEl.addEventListener('change', (e) => updateBacklogItemField(item.id, 'repoPath', e.target.value));

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

  async function updateBacklogItemField(id, field, value) {
    const result = await guarded(
      fetchJson(`/api/backlog/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
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

  async function addBacklogItem(title, repoPath, priority) {
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
        body: JSON.stringify({ title, repoPath, priority }),
      }),
      'Failed to add backlog item'
    );
    if (result === null) return;
    await loadBacklog();
  }

  // Mirrors populateMemoryProjectSelect — the add-row's repo picker needs the
  // same tracked-project list, kept in sync whenever projects load.
  function populateBacklogFolderSelect() {
    const select = document.getElementById('backlog-folder-select');
    if (!select) return;
    const previous = select.value;
    select.textContent = '';
    for (const project of trackedProjects()) {
      const option = document.createElement('option');
      option.value = project.projectPath;
      option.textContent = project.projectName || project.projectFolder;
      select.appendChild(option);
    }
    const fallback = currentTargetDirectory();
    if (previous && state.projects.some((p) => p.projectPath === previous)) {
      select.value = previous;
    } else if (fallback) {
      select.value = fallback;
    }
  }

  // ---------- chat panel (detail drawer) ----------

  function watchSession(sessionId) {
    sendWsMessage({ type: 'watch', sessionId });
  }

  function unwatchSession(sessionId) {
    sendWsMessage({ type: 'unwatch', sessionId });
  }

  // `mode` is 'replace' (the default — a plain card click reuses the focused
  // pane) or 'split' (shift-click, ⊞, ⌘K+shift — opens another pane).
  function openDetail(sessionId, mode) {
    const session = state.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    const before = openSessionIds(); // captured before setLayout mutates state.layout
    const wasOpen = before.includes(sessionId);
    setLayout(mode === 'split'
      ? layoutStore.addPane(state.layout, sessionId, { max: currentPaneCap() })
      : layoutStore.replaceFocused(state.layout, sessionId));
    // 'replace' mode (a plain card click) can knock a different session out of
    // the layout without ever calling closeDetail on it. Its server-side
    // fs.watch (transcriptWatcher.js) survives until an explicit unwatch or
    // the whole connection drops, so leaving this out would leak one live
    // watcher per session clicked through in a single pane over the life of
    // the WebSocket connection.
    const after = new Set(openSessionIds());
    for (const id of before) {
      if (!after.has(id)) unwatchSession(id);
    }
    markSessionViewed(sessionId);
    clearUnseenBadge(sessionId);
    if (!wasOpen) {
      loadChatMessages(sessionId);
      watchSession(sessionId);
    }
    syncActiveCards();
  }

  function closeDetail(sessionId) {
    const id = sessionId || focusedSessionId();
    if (!id) return;
    unwatchSession(id);
    setLayout(layoutStore.closePane(state.layout, id));
    closeSlashPopup();
    syncActiveCards();
  }

  // Pulled out of the old openDetail body: the unseen badge has to clear now,
  // not on the next poll.
  function clearUnseenBadge(sessionId) {
    for (const child of document.getElementById('session-grid').children) {
      if (child.dataset && child.dataset.sessionId === sessionId) {
        const badge = child.querySelector('.card-unseen-badge');
        if (badge) badge.classList.remove('card-status-label--unseen');
      }
    }
  }

  function syncActiveCards() {
    const open = new Set(openSessionIds());
    for (const child of document.getElementById('session-grid').children) {
      if (child.dataset) child.classList.toggle('card--active', open.has(child.dataset.sessionId));
    }
  }

  // Reconciles the DOM against state.layout: creates panes that appeared,
  // destroys panes that went away, and puts the survivors back in order. Panes
  // are matched by data-session-id and MOVED rather than rebuilt, because
  // rebuilding would throw away the transcript scroll position and whatever the
  // user had half-typed into that pane's composer.
  function renderPanes() {
    const stage = document.getElementById('pane-stage');
    const template = document.getElementById('pane-template');
    const wanted = openSessionIds();

    for (const el of Array.from(stage.querySelectorAll('.pane'))) {
      if (!wanted.includes(el.dataset.sessionId)) el.remove();
    }

    let previous = null;
    for (const pane of state.layout.panes) {
      let el = paneFor(pane.sessionId);
      if (!el) {
        el = template.content.firstElementChild.cloneNode(true);
        el.dataset.sessionId = pane.sessionId;
        stage.appendChild(el);
        wirePane(el, pane.sessionId);
        restoreComposerDraft(composerCtxFor(el));
      }
      el.style.flex = `${pane.flex} 1 0`;
      el.classList.toggle('pane--focus', pane.sessionId === state.layout.focusedId);
      // insertBefore with the node already in place is a no-op, so this both
      // inserts new panes in order and reorders survivors.
      stage.insertBefore(el, previous ? previous.nextSibling : stage.firstChild);
      previous = el;

      const session = state.sessions.find((s) => s.id === pane.sessionId);
      if (session) renderDetail(el, session);
    }

    for (const el of Array.from(stage.querySelectorAll('.divider'))) el.remove();
    const panes = Array.from(stage.querySelectorAll('.pane'));
    for (let i = 1; i < panes.length; i += 1) {
      const divider = document.createElement('div');
      divider.className = 'divider';
      divider.dataset.left = panes[i - 1].dataset.sessionId;
      divider.dataset.right = panes[i].dataset.sessionId;
      stage.insertBefore(divider, panes[i]);
    }

    stage.classList.toggle('pane-stage--empty', state.layout.panes.length === 0);
    document.querySelector('.main').classList.toggle('main--workbench', state.layout.panes.length >= 2);
    renderLayoutControl();
  }

  // The glyph is the layout: one bar per open pane, so the control reports the
  // split rather than just naming it.
  function renderLayoutControl() {
    const ctl = document.getElementById('layout-ctl');
    const count = state.layout.panes.length;
    ctl.hidden = count < 2;
    const glyph = document.getElementById('layout-glyph');
    glyph.textContent = '';
    for (let i = 0; i < count; i += 1) glyph.appendChild(document.createElement('i'));
    document.getElementById('layout-ctl-label').textContent = `${count} panes`;
  }

  // A pane stops being readable below this. The drag clamps both neighbours
  // rather than letting one collapse — a 40px pane is never something the user
  // meant to create, and getting back out of one is fiddly.
  const MIN_PANE_PX = 260;

  function wireDividerDrag() {
    const stage = document.getElementById('pane-stage');
    stage.addEventListener('mousedown', (e) => {
      const divider = e.target.closest('.divider');
      if (!divider) return;
      e.preventDefault();
      const leftEl = paneFor(divider.dataset.left);
      const rightEl = paneFor(divider.dataset.right);
      if (!leftEl || !rightEl) return;

      const startX = e.clientX;
      const leftPx = leftEl.getBoundingClientRect().width;
      const rightPx = rightEl.getBoundingClientRect().width;
      const totalPx = leftPx + rightPx;
      // Conserve the pair's combined flex so the drag never changes how much
      // room the two of them take from the panes beyond them.
      const leftFlex = state.layout.panes.find((p) => p.sessionId === divider.dataset.left).flex;
      const rightFlex = state.layout.panes.find((p) => p.sessionId === divider.dataset.right).flex;
      const totalFlex = leftFlex + rightFlex;

      document.body.classList.add('is-dragging-divider');

      function onMove(ev) {
        let px = leftPx + (ev.clientX - startX);
        px = Math.max(MIN_PANE_PX, Math.min(totalPx - MIN_PANE_PX, px));
        const ratio = px / totalPx;
        // Applied straight to the DOM during the drag; the model is updated
        // once on mouseup, so a drag is one layout write and one localStorage
        // write rather than one per mousemove.
        leftEl.style.flex = `${totalFlex * ratio} 1 0`;
        rightEl.style.flex = `${totalFlex * (1 - ratio)} 1 0`;
      }

      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.classList.remove('is-dragging-divider');
        const ratio = leftEl.getBoundingClientRect().width / totalPx;
        setLayout(layoutStore.resizePane(
          state.layout,
          divider.dataset.left, totalFlex * ratio,
          divider.dataset.right, totalFlex * (1 - ratio)
        ));
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function renderDetail(paneEl, session) {
    const status = statusOf(session);

    const spine = paneEl.querySelector('.pane-spine');
    spine.className = `pane-spine pane-spine--${status}`;

    const dot = paneEl.querySelector('.pane-status-dot');
    dot.classList.toggle('status-dot--pulse-fast', status === 'running' || status === 'needs-input');
    dot.classList.toggle('status-dot--needs-input', status === 'needs-input');

    const label = paneEl.querySelector('.pane-status-label');
    label.textContent = STATUS_LABELS[status];
    label.style.color = status === 'needs-input' ? 'var(--warn)' : status === 'running' ? 'var(--accent)' : 'var(--text-faint)';

    // needs-input is still a live process — the composer stays in its "running"
    // (Stop-button) state either way, just with a status line that says what
    // it's actually waiting on.
    setPaneComposerRunning(
      paneEl,
      status === 'running' || status === 'needs-input',
      status === 'needs-input' ? 'waiting for input…' : null,
      status === 'needs-input'
    );
    renderMcpChip(paneEl, session);

    // First measurement that can actually succeed: the pane was not in the
    // document when its composer was wired, so scrollHeight read 0 there. Only
    // measure while still unmeasured — renderPanes also runs on every poll and
    // WebSocket push, and resetting the height mid-typing resets the scroll
    // position of a textarea the user is in the middle of using.
    const input = paneEl.querySelector('.pane-send-input');
    const measured = input && input.style.height;
    if (input && (!measured || measured === 'auto' || measured === '0px')) autoGrowComposer(input);

    paneEl.querySelector('.detail-title').textContent = session.title || '(no summary yet)';
    paneEl.querySelector('.detail-meta').textContent =
      `${session.projectName || session.projectFolder}${session.gitBranch ? ' · ' + session.gitBranch : ''}`;
  }

  async function loadChatMessages(sessionId) {
    const result = await guarded(
      fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/messages`),
      'Failed to load the conversation'
    );
    const paneEl = paneFor(sessionId);
    // The user may have closed this pane while the fetch was in flight.
    if (result === null || !paneEl) return;
    renderChatMessages(paneEl.querySelector('.pane-chat-history'), result.messages);
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

  function renderChatMessages(container, messages) {
    if (!container) return;
    const paneEl = container.closest('.pane');
    // Only auto-stick to the bottom if the user was already reading the tail.
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
    container.innerHTML = '';

    if (!messages || messages.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'chat-empty';
      empty.textContent = `No conversation yet — say something to ${assistantName()}.`;
      container.appendChild(empty);
      if (paneEl) syncChatGeneratingIndicator(paneEl);
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
    if (paneEl) syncChatGeneratingIndicator(paneEl);
    if (nearBottom || container.scrollTop === 0) container.scrollTop = container.scrollHeight;
  }

  function updateOpenDetailIfPresent() {
    renderPanes();
  }

  // Killing a running agent mid-task can lose in-progress work, so this asks
  // first — same window.confirm pattern used for deleting a backlog item.
  // On success the running indicator is greyed out immediately (optimistic);
  // the next WebSocket session-status push or poll will confirm or correct it.
  async function cancelRunningSession(paneEl) {
    const sessionId = paneEl.dataset.sessionId;
    if (!sessionId) return;
    if (!window.confirm('Cancel this running session? Any in-progress work may be lost.')) return;

    const btn = paneEl.querySelector('.pane-send-btn');
    const statusText = paneEl.querySelector('.pane-composer-status-text');
    if (btn) btn.disabled = true;
    if (statusText) statusText.textContent = 'stopping…';

    const result = await guarded(
      fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: 'POST' }),
      'Failed to cancel the session'
    );

    if (result === null || !result.cancelled) {
      setPaneComposerRunning(paneEl, true);
      return;
    }

    showToast('Session cancelled.', false);
    const session = state.sessions.find((s) => s.id === sessionId);
    if (session) session.isRunning = false;
    // Unconditionally, before anything that can bail out: this is the only
    // path that disables the send button, and every route back to enabled ran
    // through a renderPanes that isn't guaranteed to happen — not when the
    // session is missing from state.sessions (a dashboard-spawned run whose
    // real id isn't known yet), and not when the loadSessions below fails and
    // returns early. Either left the composer permanently unusable.
    setPaneComposerRunning(paneEl, false);
    renderSessions();
    updateHeaderStats();
    renderPanes();
    await loadSessions();
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

  // The command bar's selects are fixed ids; every pane clones its own from
  // the template, so there can be any number of `.pane-model-select`s on
  // screen at once — these two gather all of them, live, rather than a
  // snapshot list that would go stale as panes open and close.
  function modelSelectEls() {
    const els = [document.getElementById('command-model-select')];
    document.querySelectorAll('.pane-model-select').forEach((el) => els.push(el));
    return els.filter(Boolean);
  }

  function permissionSelectEls() {
    const els = [document.getElementById('command-permission-select')];
    document.querySelectorAll('.pane-permission-select').forEach((el) => els.push(el));
    return els.filter(Boolean);
  }

  function applyControlPrefsToSelects() {
    const model = readModelPref();
    const permission = readPermissionPref();
    for (const el of modelSelectEls()) el.value = model;
    for (const el of permissionSelectEls()) {
      el.value = permission;
      // The warn treatment lands on the wrapper so it covers the custom
      // caret too — the select itself no longer has a box of its own.
      const wrap = el.closest('.composer-select-wrap');
      if (wrap) wrap.classList.toggle('composer-select-wrap--armed', !!permission);
    }
  }

  function wireControlSelectChange(el, kind) {
    if (!el) return;
    el.addEventListener('change', () => {
      if (kind === 'model') saveModelPref(el.value);
      else savePermissionPref(el.value);
      applyControlPrefsToSelects();
    });
  }

  // Wires the command bar's selects only — called once at init. A pane's own
  // selects don't exist yet at that point (they're cloned from the template
  // on demand), so wirePane calls wirePaneControlSelects below for each one.
  function wireControlSelects() {
    wireControlSelectChange(document.getElementById('command-model-select'), 'model');
    wireControlSelectChange(document.getElementById('command-permission-select'), 'permission');
  }

  function wirePaneControlSelects(paneEl) {
    wireControlSelectChange(paneEl.querySelector('.pane-model-select'), 'model');
    wireControlSelectChange(paneEl.querySelector('.pane-permission-select'), 'permission');
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
    default: 'Ask',
  };

  function labelDefaultOption(el, text) {
    const opt = el && el.querySelector('option[value=""]');
    if (opt) opt.textContent = text;
  }

  // Cached so a pane opened after this fetch resolves still gets the label —
  // see applyCachedDefaultLabels, called from wirePane.
  let cachedModelDefaultText = null;
  let cachedPermissionDefaultText = null;

  async function loadClaudeDefaultsLabel() {
    const result = await fetchJson('/api/claude-defaults').catch(() => null);
    if (!result) return;
    if (result.model) {
      const label = MODEL_DEFAULT_LABELS[result.model] || result.model;
      cachedModelDefaultText = `Default (${label})`;
      for (const el of modelSelectEls()) labelDefaultOption(el, cachedModelDefaultText);
    }
    if (result.permissionMode) {
      const label = PERMISSION_DEFAULT_LABELS[result.permissionMode] || result.permissionMode;
      cachedPermissionDefaultText = `Default (${label})`;
      for (const el of permissionSelectEls()) labelDefaultOption(el, cachedPermissionDefaultText);
    }
  }

  function applyCachedDefaultLabels(paneEl) {
    if (cachedModelDefaultText) labelDefaultOption(paneEl.querySelector('.pane-model-select'), cachedModelDefaultText);
    if (cachedPermissionDefaultText) labelDefaultOption(paneEl.querySelector('.pane-permission-select'), cachedPermissionDefaultText);
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

  // ---------- detail composer state ----------
  //
  // While the agent runs, the send control becomes Stop in place and the model
  // and permission selects give way to the working indicator: those two only
  // apply to the *next* message, and a session already in flight can't take one.
  // Before this, the send button had no isRunning wiring at all, so a second
  // message could be fired at a busy agent — which lands both sends on one entry
  // in claudeCli's running map, and the first to finish flips isRunning false
  // while the second is still going.

  // Cycles a braille spinner plus an elapsed-seconds count next to the status
  // text while a run is in flight — a static "is working…" label didn't read
  // as alive. Keyed by textEl so repeated calls with the same label (this
  // fires on every poll while a session runs) don't restart the elapsed timer.
  const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const workingAnimations = new Map(); // textEl -> { intervalId, label, start, frame }

  function startWorkingAnimation(textEl, label) {
    if (!textEl) return;
    const existing = workingAnimations.get(textEl);
    if (existing && existing.label === label) return;
    if (existing) clearInterval(existing.intervalId);
    const anim = { label, start: Date.now(), frame: 0, intervalId: null };
    const render = () => {
      const elapsed = Math.floor((Date.now() - anim.start) / 1000);
      textEl.textContent = `${SPINNER_FRAMES[anim.frame % SPINNER_FRAMES.length]} ${label} ${elapsed}s`;
      anim.frame += 1;
    };
    render();
    anim.intervalId = setInterval(render, 120);
    workingAnimations.set(textEl, anim);
  }

  function stopWorkingAnimation(textEl) {
    const existing = textEl && workingAnimations.get(textEl);
    if (!existing) return;
    clearInterval(existing.intervalId);
    workingAnimations.delete(textEl);
  }

  // Whether each open pane is generating, and what to say. Keyed by pane
  // element rather than held as a module-level flag, because several agents
  // now run at once and a shared flag put one session's spinner in every pane.
  // Set only by setPaneComposerRunning below, so the chat feed and the composer
  // status never disagree about it. renderChatMessages rebuilds the feed from
  // scratch on every transcript update, which would otherwise drop this row as
  // fast as it's added; syncChatGeneratingIndicator re-adds it from this state
  // every time, immediately on send and after every rebuild.
  const paneGenerating = new WeakMap(); // paneEl -> { generating, label }

  function syncChatGeneratingIndicator(paneEl) {
    const container = paneEl.querySelector('.pane-chat-history');
    if (!container) return;
    const st = paneGenerating.get(paneEl) || { generating: false, label: '' };
    let row = container.querySelector('.chat-generating-indicator');
    if (st.generating) {
      if (!row) {
        row = document.createElement('div');
        row.className = 'chat-generating-indicator chat-row chat-row--assistant';
        const avatar = document.createElement('span');
        avatar.className = 'orb orb--dot';
        row.appendChild(avatar);
        const bubble = document.createElement('div');
        bubble.className = 'chat-msg chat-msg--generating';
        row.appendChild(bubble);
        container.appendChild(row);
      }
      startWorkingAnimation(row.querySelector('.chat-msg'), st.label);
    } else if (row) {
      stopWorkingAnimation(row.querySelector('.chat-msg'));
      row.remove();
    }
  }

  function setPaneComposerRunning(paneEl, running, statusText, needsInput) {
    const composer = paneEl.querySelector('.pane-composer');
    const btn = paneEl.querySelector('.pane-send-btn');
    const status = paneEl.querySelector('.pane-composer-status');
    const text = paneEl.querySelector('.pane-composer-status-text');
    const dot = status ? status.querySelector('.composer-status-dot') : null;

    if (composer) composer.classList.toggle('composer--running', running);
    if (status) {
      status.hidden = !running;
      status.classList.toggle('composer-status--needs-input', !!needsInput);
    }
    if (dot) dot.classList.toggle('composer-status-dot--needs-input', !!needsInput);
    // The animated spinner lives in the chat feed itself
    // (syncChatGeneratingIndicator above) — this status line next to the send
    // button stays static so the same "generating" motion isn't duplicated
    // right under the input box.
    if (text && running) text.textContent = statusText || `${assistantName()} is working…`;
    if (btn) {
      btn.dataset.mode = running ? 'stop' : 'send';
      btn.classList.toggle('composer-send--stop', running);
      btn.textContent = running ? '■' : '↑';
      btn.title = running ? 'Stop this session' : 'Send (Enter)';
      btn.setAttribute('aria-label', running ? 'Stop this session' : 'Send');
      btn.disabled = false;
    }
    paneGenerating.set(paneEl, {
      generating: running,
      label: statusText || `${assistantName()} is working…`,
    });
    syncChatGeneratingIndicator(paneEl);
  }

  // `claude mcp list` live-checks every server over the network (~15s), so it
  // stays strictly on demand — see checkMcpStatus. What this adds is memory:
  // once a project has been checked, the rail chip keeps reporting the result
  // instead of going back to a bare "mcp" that says nothing.
  const mcpStatusByPath = new Map(); // normalized project path -> { total, connected }

  function renderMcpChip(paneEl, session) {
    const dot = paneEl.querySelector('.pane-mcp-dot');
    const label = paneEl.querySelector('.pane-mcp-label');
    if (!dot || !label) return;
    const projectPath = session && session.projectPath;
    const known = projectPath ? mcpStatusByPath.get(normalizeClientPath(projectPath)) : null;
    // Reset to base state without dropping the .pane-mcp-dot lookup class this
    // element is found by — this runs on every render (renderDetail fires on
    // every poll), and a plain className overwrite would strand the next
    // lookup with nothing to find.
    dot.className = 'composer-chip-dot pane-mcp-dot';
    if (!known) {
      label.textContent = 'mcp';
      return;
    }
    label.textContent = String(known.total);
    if (known.total > 0) {
      dot.classList.add(known.connected === known.total ? 'composer-chip-dot--ok' : 'composer-chip-dot--warn');
    }
  }

  async function sendFromPane(paneEl) {
    const sessionId = paneEl.dataset.sessionId;
    if (!sessionId) return;
    const input = paneEl.querySelector('.pane-send-input');
    const message = input ? input.value : '';
    if (!message || !message.trim()) {
      showToast('Type a message before sending.');
      return;
    }
    setPaneComposerRunning(paneEl, true);

    try {
      await fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, ...currentModelAndPermissionFields(paneEl) }),
      });
      // 202 means accepted, not finished. The composer stays in its running
      // state until a session-status push or the 10s poll says the run ended —
      // releasing it here would re-enable Send while the agent is mid-run,
      // which is exactly the double-send this state exists to prevent.
      await loadSessions();
    } catch (err) {
      const errorMessage = err && err.message ? err.message : 'Failed to send the message';
      console.error('Failed to send message to session', err);
      showToast(errorMessage);
      // The run never started, so nothing will arrive to unlock the composer.
      setPaneComposerRunning(paneEl, false);
      renderPanes();
    }
  }

  // ---------- composers ----------
  //
  // Two prompt surfaces share one implementation: the command bar (starts a new
  // session in the chosen directory) and the drawer footer (follow-up message to
  // the open session). They differ only in where the project path comes from, so
  // everything below is written against a context object — the auto-grow, the
  // slash popup and the @ picker are defined once and can't drift apart.

  // Both composer surfaces are described the same way, so every behaviour
  // written against a context — slash, @, history, drafts, auto-grow — works
  // for a pane without knowing panes exist. The accessors are functions rather
  // than element references because a pane can be removed from the DOM and its
  // context must go inert rather than resurrect a detached node.
  const COMMAND_COMPOSER = {
    key: 'command',
    input: () => document.getElementById('command-input'),
    popup: () => document.getElementById('command-slash-popup'),
    sessionId: () => null,
    projectPath: () => currentTargetDirectory(),
  };

  const paneCtxCache = new WeakMap();

  function composerCtxFor(paneEl) {
    let ctx = paneCtxCache.get(paneEl);
    if (ctx) return ctx;
    ctx = {
      // One shared history ring for every pane, deliberately. A per-pane ring
      // could never do the thing recall exists for: re-running a prompt against
      // a different session.
      key: 'detail',
      input: () => paneEl.querySelector('.pane-send-input'),
      popup: () => paneEl.querySelector('.pane-slash-popup'),
      sessionId: () => paneEl.dataset.sessionId,
      projectPath: () => {
        const session = state.sessions.find((s) => s.id === paneEl.dataset.sessionId);
        return (session && session.projectPath) || null;
      },
    };
    paneCtxCache.set(paneEl, ctx);
    return ctx;
  }

  function composerInput(ctx) { return ctx.input(); }

  // The textarea carries no fixed height — it is re-measured against its own
  // content on every change. scrollHeight only reports the content height once
  // the current height is released, hence the reset to 'auto' first. The cap
  // and the resulting scrollbar live in CSS (.composer-input).
  function autoGrowComposer(input) {
    if (!input) return;
    input.style.height = 'auto';
    // An unrendered textarea — the drawer's, before it is ever opened — reports
    // scrollHeight 0, and pinning height:0 would collapse it the moment it did
    // become visible. Leaving height:auto falls back to the rows="1" default,
    // and renderDetail re-measures once the drawer is laid out.
    if (input.scrollHeight > 0) input.style.height = `${input.scrollHeight}px`;
  }

  function clearComposer(input) {
    if (!input) return;
    input.value = '';
    autoGrowComposer(input);
  }

  // ---------- prompt history + drafts ----------
  //
  // Two localStorage-backed conveniences over the composers. Both follow the
  // same guarded read/write idiom as the prefs above: a browser with storage
  // disabled (private mode, quota exhausted) degrades to in-memory-only for the
  // page's lifetime rather than throwing.
  //
  // HISTORY SCOPE is per composer *surface* — one ring for the command bar, one
  // for the drawer — not global and not per session. The command bar starts new
  // work ("add rate limiting to the API"); the drawer sends follow-ups ("now run
  // the tests", "revert that"). One shared ring would make ↑ in the command bar
  // offer sentence fragments that only meant anything inside one conversation.
  // Per-session is too narrow in the other direction: the whole point of recall
  // is re-running a tweaked variant of a prompt against a *different* session,
  // which a per-session ring can never offer.
  //
  // DRAFT KEYS are per session id for the drawer, and a single global key for
  // the command bar. There is only one command bar, and its content is a task
  // you are composing — often typed *before* the directory chip is set (the
  // send path explicitly prompts "pick a directory first"). Keying it by target
  // directory would blank the box the moment you changed the chip, destroying
  // exactly the text the feature exists to protect.

  const PROMPT_HISTORY_KEY = 'djinn.promptHistory';
  const COMPOSER_DRAFTS_KEY = 'djinn.composerDrafts';

  // 50 entries per surface is far more than anyone walks by hand and still a
  // small payload. The character budget is the real guard: a single pasted
  // stack trace can be tens of KB, and localStorage is ~5MB for the whole
  // origin — shared with viewed-sessions, drafts and prefs. Entries are never
  // truncated (a half prompt, recalled and sent, is worse than no history), so
  // the budget evicts whole oldest entries instead.
  const HISTORY_MAX_ENTRIES = 50;
  const HISTORY_MAX_CHARS = 40000;
  const MAX_SESSION_DRAFTS = 30;
  const DRAFTS_MAX_CHARS = 200000;

  function readHistoryStore() {
    try {
      const raw = localStorage.getItem(PROMPT_HISTORY_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {}; // private mode / corrupt value — behave as "no history"
    }
  }

  function writeHistoryStore(store) {
    try {
      localStorage.setItem(PROMPT_HISTORY_KEY, JSON.stringify(store));
    } catch {
      // storage disabled or full — non-fatal, history just won't persist
    }
  }

  // Newest first.
  function readPromptHistory(ctx) {
    const list = readHistoryStore()[ctx.key];
    return Array.isArray(list) ? list.filter((e) => typeof e === 'string') : [];
  }

  // Empty and whitespace-only sends are never recorded. Exact duplicates
  // collapse to their newest occurrence anywhere in the ring, not just when
  // consecutive (readline's `erasedups`): the prompts people re-send are by
  // definition the ones they send repeatedly, and letting them pile up would
  // push everything else off the end of a bounded list.
  function pushPromptHistory(ctx, text) {
    const entry = String(text == null ? '' : text);
    if (!entry.trim()) return;
    const list = readPromptHistory(ctx).filter((e) => e !== entry);
    list.unshift(entry);
    let total = list.reduce((n, e) => n + e.length, 0);
    // The length > 1 guard keeps a single oversized entry rather than emptying
    // the ring outright — the newest prompt is the one most likely wanted back.
    while (list.length > HISTORY_MAX_ENTRIES || (list.length > 1 && total > HISTORY_MAX_CHARS)) {
      total -= list.pop().length;
    }
    const store = readHistoryStore();
    store[ctx.key] = list;
    writeHistoryStore(store);
  }

  // Walk position per surface, in memory only — where you are in the ring is
  // not worth restoring across reloads. index === -1 means "not walking".
  // `pending` is whatever the user had typed before the first ↑, so ↓ can put
  // it back. `recalled` is the exact string this walk last wrote into the box:
  // if the value has since drifted from it (typing, a slash pick, an @ insert)
  // the walk is stale and the next ↑ starts a fresh one.
  const historyWalk = {
    command: { index: -1, pending: '', recalled: null },
    detail: { index: -1, pending: '', recalled: null },
  };

  function resetHistoryWalk(ctx) {
    const walk = historyWalk[ctx.key];
    if (!walk) return;
    walk.index = -1;
    walk.pending = '';
    walk.recalled = null;
  }

  function setComposerValue(ctx, value) {
    const input = composerInput(ctx);
    if (!input) return;
    input.value = value;
    const end = value.length;
    input.setSelectionRange(end, end);
    autoGrowComposer(input); // a recalled multi-line prompt must come back tall
    // What gets *persisted* mid-walk is the text the user was writing, not the
    // history entry currently on display. walk.pending lives only in memory, so
    // saving input.value here meant that opening another session part-way
    // through a walk overwrote the real draft with somebody's old prompt and
    // lost the unsent one for good — the precise thing drafts exist to prevent.
    // Once the walk ends, this is input.value again and the two agree.
    const walk = historyWalk[ctx.key];
    saveComposerDraftText(ctx, walk && walk.index >= 0 ? walk.pending : input.value);
  }

  // Returns true when the key was consumed and the caller should preventDefault.
  //
  // TRIGGER RULE — recall must never steal a caret move the user meant:
  //   ↑ recalls when the composer is empty or whitespace-only, OR the selection
  //     is collapsed at offset 0, OR a walk is already in progress and the box
  //     still holds exactly what that walk put there.
  //   ↓ only ever moves forward inside an in-progress, untouched walk.
  //
  // Offset 0 is the boundary rather than "the value contains no newline",
  // because a long single-logical-line prompt soft-wraps to several visual rows
  // in a textarea and ↑ inside those rows is a real caret move the user wants.
  // At offset 0 there is no row above to reach in either case, so nothing is
  // stolen. Once a walk is underway the recalled entry behaves as one readline
  // "line" — ↑ keeps walking back through it however many rows it occupies,
  // which is what a shell does — until an edit ends the walk.
  function walkPromptHistory(ctx, direction) {
    const input = composerInput(ctx);
    const walk = historyWalk[ctx.key];
    if (!input || !walk) return false;

    const walking = walk.index >= 0 && input.value === walk.recalled;
    const list = readPromptHistory(ctx);

    if (!walking) {
      if (direction < 0) return false; // ↓ never starts a walk
      const caretAtStart = input.selectionStart === 0 && input.selectionEnd === 0;
      if (!caretAtStart && input.value.trim() !== '') return false;
      if (list.length === 0) return false;
      walk.pending = input.value;
      walk.index = 0;
      walk.recalled = list[0];
      setComposerValue(ctx, list[0]);
      return true;
    }

    if (list.length === 0) { resetHistoryWalk(ctx); return false; }
    const next = walk.index + (direction > 0 ? 1 : -1);
    // Already at the oldest entry: swallow the key rather than let the caret
    // jump out of a prompt the user is looking at.
    if (next >= list.length) return true;
    if (next < 0) {
      const pending = walk.pending;
      resetHistoryWalk(ctx);
      setComposerValue(ctx, pending);
      return true;
    }
    walk.index = next;
    walk.recalled = list[next];
    setComposerValue(ctx, list[next]);
    return true;
  }

  function readDraftStore() {
    try {
      const raw = localStorage.getItem(COMPOSER_DRAFTS_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeDraftStore(store) {
    try {
      localStorage.setItem(COMPOSER_DRAFTS_KEY, JSON.stringify(store));
    } catch {
      // storage disabled or full — the in-memory textarea is unaffected
    }
  }

  function draftKeyFor(ctx) {
    if (ctx.key === 'command') return 'command';
    const id = ctx.sessionId();
    return id ? `session:${id}` : null;
  }

  // Keeps the newest MAX_SESSION_DRAFTS session drafts, then keeps dropping the
  // oldest of those until the whole payload fits the character budget — so one
  // enormous pasted draft can't make every future write fail the quota and take
  // all the other sessions' drafts down with it. The command-bar draft is never
  // evicted; it is the one draft with nowhere else to live.
  function trimDraftStore(store) {
    const sessionKeys = Object.keys(store)
      .filter((k) => k.startsWith('session:'))
      .sort((a, b) => ((store[b] && store[b].at) || 0) - ((store[a] && store[a].at) || 0));
    for (const key of sessionKeys.slice(MAX_SESSION_DRAFTS)) delete store[key];
    const kept = sessionKeys.slice(0, MAX_SESSION_DRAFTS);
    while (kept.length && JSON.stringify(store).length > DRAFTS_MAX_CHARS) {
      delete store[kept.pop()];
    }
    return store;
  }

  function saveComposerDraft(ctx) {
    const input = composerInput(ctx);
    if (!input) return;
    saveComposerDraftText(ctx, input.value);
  }

  // Persists `text` as this composer's draft. Split out from saveComposerDraft
  // because during a history walk the box and the draft legitimately hold
  // different things — see setComposerValue.
  function saveComposerDraftText(ctx, text) {
    const key = draftKeyFor(ctx);
    if (!key) return;
    const store = readDraftStore();
    if (!text) {
      if (!(key in store)) return; // nothing stored, nothing to clear
      delete store[key];
    } else {
      store[key] = { text, at: Date.now() };
    }
    writeDraftStore(trimDraftStore(store));
  }

  function clearComposerDraft(ctx) {
    const key = draftKeyFor(ctx);
    if (!key) return;
    const store = readDraftStore();
    if (!(key in store)) return;
    delete store[key];
    writeDraftStore(store);
  }

  // Also the "no draft" path: writing '' is what stops the previous session's
  // half-typed message leaking into the one you just opened.
  function restoreComposerDraft(ctx) {
    const input = composerInput(ctx);
    if (!input) return;
    const key = draftKeyFor(ctx);
    const entry = key ? readDraftStore()[key] : null;
    const text = entry && typeof entry.text === 'string' ? entry.text : '';
    input.value = text;
    autoGrowComposer(input);
    resetHistoryWalk(ctx);
  }

  // Once per page load, after the first session list arrives: a draft keyed to
  // a session id the server no longer reports can never be reached again.
  let draftsPruned = false;
  function pruneDraftsForMissingSessions() {
    if (draftsPruned || state.sessions.length === 0) return;
    draftsPruned = true;
    const live = new Set(state.sessions.map((s) => `session:${s.id}`));
    const store = readDraftStore();
    let changed = false;
    for (const key of Object.keys(store)) {
      if (key.startsWith('session:') && !live.has(key)) {
        delete store[key];
        changed = true;
      }
    }
    if (changed) writeDraftStore(store);
  }

  // The one funnel for "this message has actually left the box": record it in
  // that surface's history, drop its saved draft (a draft that survives its own
  // send would come back on the next visit as a duplicate), clear the input.
  function commitComposerSend(ctx) {
    const input = composerInput(ctx);
    if (!input) return;
    pushPromptHistory(ctx, input.value);
    clearComposerDraft(ctx);
    resetHistoryWalk(ctx);
    clearComposer(input);
  }

  // ---------- slash-command autocomplete ----------
  //
  // Commands are cached per project path so retyping "/" doesn't refetch on
  // every keystroke; a fetch failure is treated as "no commands available",
  // not fatal.

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
    ctx: null,      // which composer the popup currently belongs to
  };

  // Only one popup can be open at a time, so this closes whichever composer
  // owns it rather than taking a context argument — callers that just want the
  // popup gone (Escape, closing the drawer, blur) don't have to know which.
  function closeSlashPopup() {
    const ctx = slashState.ctx;
    slashState.open = false;
    slashState.items = [];
    slashState.ctx = null;
    if (!ctx) return;
    const popup = ctx.popup();
    if (popup) {
      popup.hidden = true;
      popup.textContent = '';
    }
  }

  function renderSlashPopup() {
    const popup = slashState.ctx && slashState.ctx.popup();
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
    const input = slashState.ctx && composerInput(slashState.ctx);
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
    autoGrowComposer(input);
    closeSlashPopup();
  }

  function moveSlashActive(delta) {
    if (slashState.items.length === 0) return;
    slashState.activeIndex = (slashState.activeIndex + delta + slashState.items.length) % slashState.items.length;
    renderSlashPopup();
  }

  async function handleComposerSlash(ctx) {
    const input = composerInput(ctx);
    if (!input) {
      closeSlashPopup();
      return;
    }
    const cursor = input.selectionStart != null ? input.selectionStart : input.value.length;
    const match = SLASH_TRIGGER_RE.exec(input.value.slice(0, cursor));
    if (!match) {
      closeSlashPopup();
      return;
    }
    // Only one popup is ever open. Hand-off between composers has to close the
    // outgoing one first — overwriting slashState.ctx would otherwise strand
    // the previous popup on screen with nothing left holding a reference to it.
    if (slashState.ctx && slashState.ctx !== ctx) closeSlashPopup();
    slashState.open = true;
    slashState.ctx = ctx;
    slashState.matchStart = match.index + (match[0].length - match[1].length - 1);

    const projectPath = ctx.projectPath();
    if (!projectPath) {
      closeSlashPopup();
      return;
    }

    const pathAtFetch = projectPath;
    const commands = await fetchCommandsForPath(projectPath);
    // The user may have kept typing, moved the caret off the slash token, or
    // switched sessions/directories entirely while this was in flight.
    if (slashState.ctx !== ctx || ctx.projectPath() !== pathAtFetch) return;
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

  // ---------- rail buttons: @ (insert a file path) and / (slash commands) ----------

  function insertTextAtCursor(input, text) {
    const start = input.selectionStart != null ? input.selectionStart : input.value.length;
    const end = input.selectionEnd != null ? input.selectionEnd : input.value.length;
    const value = input.value;
    input.value = value.slice(0, start) + text + value.slice(end);
    const cursor = start + text.length;
    input.setSelectionRange(cursor, cursor);
    input.focus();
    autoGrowComposer(input);
  }

  async function browseForFile(ctx) {
    const result = await guarded(
      fetchJson('/api/directories/browse-file', { method: 'POST' }),
      'Failed to open the file picker'
    );
    if (result === null) return;
    if (!result.path) return; // user cancelled the native dialog
    const input = composerInput(ctx);
    if (input) insertTextAtCursor(input, `@${result.path} `);
  }

  // Slash commands were fully wired but discoverable only through placeholder
  // text that disappears the moment anyone types. The button types the "/" the
  // user would have typed, so there is exactly one code path to the popup.
  function openSlashFromButton(ctx) {
    const input = composerInput(ctx);
    if (!input) return;
    const start = input.selectionStart != null ? input.selectionStart : input.value.length;
    const needsSpace = start > 0 && !/\s$/.test(input.value.slice(0, start));
    insertTextAtCursor(input, needsSpace ? ' /' : '/');
    handleComposerSlash(ctx);
  }

  // The four command pills were decorative for the whole of v1: `.pill` carries
  // cursor:pointer and an accent hover, so they read as buttons, but no handler
  // was ever bound and clicking one did nothing. They now fill the composer
  // with a starting scaffold, and hide themselves the moment it has content —
  // which is what lets a click replace the value outright without ever
  // destroying something the user typed.
  function updateCommandPillsVisibility() {
    const wrap = document.getElementById('command-pills');
    const input = composerInput(COMMAND_COMPOSER);
    if (wrap && input) wrap.hidden = input.value.trim().length > 0;
  }

  function wireCommandPills() {
    const wrap = document.getElementById('command-pills');
    const input = composerInput(COMMAND_COMPOSER);
    if (!wrap || !input) return;
    for (const pill of wrap.querySelectorAll('.pill')) {
      pill.addEventListener('click', () => {
        const template = pill.dataset.template || '';
        const caret = template.indexOf('|');
        input.value = template.replace('|', '');
        autoGrowComposer(input);
        input.focus();
        const pos = caret === -1 ? input.value.length : caret;
        input.setSelectionRange(pos, pos);
        updateCommandPillsVisibility();
      });
    }
    input.addEventListener('input', updateCommandPillsVisibility);
    updateCommandPillsVisibility();
  }

  // Enter submits and Shift+Enter breaks the line — the convention every chat
  // client uses, and the whole reason both inputs are textareas now. While the
  // slash popup is open the arrow keys, Enter, Tab and Escape belong to it.
  function wireComposer(ctx, onSubmit) {
    const input = composerInput(ctx);
    if (!input) return;

    input.addEventListener('keydown', (e) => {
      if (slashState.open && slashState.ctx === ctx) {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveSlashActive(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); moveSlashActive(-1); return; }
        if ((e.key === 'Enter' || e.key === 'Tab') && slashState.items.length > 0) {
          e.preventDefault();
          applySlashSelection(slashState.activeIndex);
          return;
        }
        if (e.key === 'Escape') { e.preventDefault(); closeSlashPopup(); return; }
      }
      // Shell-style prompt recall. Modified arrows are left alone: Shift+↑ is
      // selection extension and Alt/Ctrl/Cmd+↑ are word/document moves, none of
      // which anyone means as "give me my last prompt". The slash popup claims
      // the arrows first (above) and returns, so the two never collide.
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown')
          && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        if (walkPromptHistory(ctx, e.key === 'ArrowUp' ? 1 : -1)) {
          e.preventDefault();
          return;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onSubmit();
      }
    });
    input.addEventListener('input', () => {
      autoGrowComposer(input);
      saveComposerDraft(ctx);
      handleComposerSlash(ctx);
    });
    input.addEventListener('click', () => handleComposerSlash(ctx));
    // Close only the popup this composer owns. closeSlashPopup() closes
    // whichever one is open, and blur fires as focus lands elsewhere — so an
    // unconditional call here can shut a popup that already belongs to the
    // composer being focused. Hand-off is still handleComposerSlash's job.
    input.addEventListener('blur', () => {
      if (slashState.ctx === ctx) closeSlashPopup();
    });
    autoGrowComposer(input);
  }

  // ---------- MCP server status panel ----------
  //
  // `claude mcp list` live-checks each server over the network (~15s in
  // testing), so this only ever runs when the user clicks the button —
  // never on drawer open, never polled.

  function closeMcpPanel(paneEl) {
    const panel = paneEl.querySelector('.pane-mcp-panel');
    if (panel) panel.hidden = true;
  }

  function toggleMcpPanel(paneEl) {
    const panel = paneEl.querySelector('.pane-mcp-panel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) checkMcpStatus(paneEl);
  }

  async function checkMcpStatus(paneEl) {
    const sessionId = paneEl.dataset.sessionId;
    if (!sessionId) return;
    const session = state.sessions.find((s) => s.id === sessionId);
    const projectPath = session && session.projectPath;
    const panel = paneEl.querySelector('.pane-mcp-panel');
    const body = paneEl.querySelector('.pane-mcp-panel-body');
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
    // The user may have closed the panel or closed this pane while this was in flight.
    if (panel.hidden || !document.body.contains(paneEl)) return;

    body.innerHTML = '';
    if (result === null) {
      const err = document.createElement('div');
      err.className = 'mcp-panel-error';
      err.textContent = 'Failed to check MCP server status.';
      body.appendChild(err);
      return;
    }

    const servers = result.servers || [];
    mcpStatusByPath.set(normalizeClientPath(projectPath), {
      total: servers.length,
      connected: servers.filter((s) => s.status === 'connected').length,
    });
    renderMcpChip(paneEl, session);

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
      const qsStatus = statusOf(session);
      dot.className = `quick-switcher-item-status${qsStatus !== 'idle' ? ` quick-switcher-item-status--${qsStatus}` : ''}`;
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

  function selectQuickSwitcherItem(idx, mode) {
    const session = quickSwitcherState.items[idx];
    if (!session) return;
    closeQuickSwitcher();
    openDetail(session.id, mode); // same function the session cards use
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
      else if (e.key === 'Enter') { e.preventDefault(); selectQuickSwitcherItem(quickSwitcherState.activeIndex, e.shiftKey ? 'split' : 'replace'); }
      // Escape is handled by the document-level handler below.
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeQuickSwitcher();
    });
    document.addEventListener('keydown', (e) => {
      // Ctrl rather than Cmd/Meta: on macOS Cmd+1..9 is the browser's own tab
      // switcher and cannot be taken. Ctrl+N is free in both.
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key >= '1' && e.key <= '4') {
        const pane = state.layout.panes[Number(e.key) - 1];
        if (pane) {
          e.preventDefault();
          setLayout(layoutStore.focusPane(state.layout, pane.sessionId));
          const input = paneFor(pane.sessionId).querySelector('.pane-send-input');
          if (input) input.focus();
        }
        return;
      }
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

  // POST /api/sessions blocks until the agent finishes — `--print` is
  // synchronous and requestTimeout is 0 — so this call can be outstanding for
  // minutes with nothing on screen to say so. Without this flag the send button
  // stays live the whole time and an impatient second click spawns a second
  // agent in the same directory. Unlike the drawer's Stop, there is nothing to
  // cancel here: the CLI hasn't returned a session id yet, so there is no id to
  // cancel by. The control disables rather than turning into Stop.
  let commandSendInFlight = false;

  function setCommandComposerBusy(busy) {
    commandSendInFlight = busy;
    const composer = document.getElementById('command-composer');
    const btn = document.getElementById('command-send-btn');
    const status = document.getElementById('command-composer-status');
    const text = document.getElementById('command-composer-status-text');
    if (composer) composer.classList.toggle('composer--running', busy);
    if (status) status.hidden = !busy;
    if (text) {
      if (busy) startWorkingAnimation(text, `${assistantName()} is working…`);
      else stopWorkingAnimation(text);
    }
    if (btn) {
      btn.disabled = busy;
      btn.title = busy ? 'Waiting for the agent to finish…' : 'Start a session (Enter)';
    }
  }

  async function startNewSession(cwd) {
    if (commandSendInFlight) return;
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
    setCommandComposerBusy(true);
    let result;
    try {
      result = await guarded(
        fetchJson('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd, message, ...currentModelAndPermissionFields() }),
        }),
        'Failed to start session'
      );
    } finally {
      setCommandComposerBusy(false);
    }
    if (result === null) return;
    commitComposerSend(COMMAND_COMPOSER);
    updateCommandPillsVisibility(); // clearing fires no input event
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
      // every chat currently open, not just one.
      for (const id of openSessionIds()) watchSession(id);
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
      } else if (msg.type === 'session-error') {
        showToast(msg.message || 'The agent run failed');
        loadSessions();
      } else if (msg.type === 'transcript-update' && openSessionIds().includes(msg.sessionId)) {
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

  // Enter never stops a session — a keystroke that far from the user's intent
  // shouldn't be able to kill a run. Stop is the button, deliberately clicked.
  // This also owns the commit-on-send bookkeeping (history, draft, slash
  // popup) that used to live in the singleton's sendFromDetailComposer.
  function commitAndSendFromPane(paneEl) {
    const btn = paneEl.querySelector('.pane-send-btn');
    if (btn && btn.dataset.mode === 'stop') {
      showToast('That agent is still working — stop it, or wait for it to finish.');
      return;
    }
    const ctx = composerCtxFor(paneEl);
    sendFromPane(paneEl); // async; reads the value before we clear it
    commitComposerSend(ctx);
    closeSlashPopup();
  }

  function wirePane(paneEl, sessionId) {
    const ctx = composerCtxFor(paneEl);
    wireComposer(ctx, () => commitAndSendFromPane(paneEl));
    wirePaneControlSelects(paneEl);
    applyControlPrefsToSelects();
    applyCachedDefaultLabels(paneEl);
    paneEl.querySelector('.pane-attach-btn').addEventListener('click', () => browseForFile(ctx));
    paneEl.querySelector('.pane-slash-btn').addEventListener('click', () => openSlashFromButton(ctx));
    paneEl.querySelector('.pane-close-btn').addEventListener('click', () => closeDetail(sessionId));
    paneEl.querySelector('.pane-minimize-btn').addEventListener('click', () => {
      unwatchSession(paneEl.dataset.sessionId);
      setLayout(layoutStore.minimizePane(state.layout, paneEl.dataset.sessionId));
    });
    paneEl.querySelector('.pane-mcp-btn').addEventListener('click', () => toggleMcpPanel(paneEl));
    paneEl.querySelector('.pane-mcp-panel-close').addEventListener('click', () => closeMcpPanel(paneEl));
    // One button, two jobs, as before: setPaneComposerRunning owns
    // dataset.mode, so the handler never has to consult session state itself.
    // Enter deliberately never stops a session — only this button does.
    paneEl.querySelector('.pane-send-btn').addEventListener('click', (e) => {
      if (e.currentTarget.dataset.mode === 'stop') cancelRunningSession(paneEl);
      else commitAndSendFromPane(paneEl);
    });
    // mousedown, not click: focus must follow before a keystroke in this pane's
    // composer is routed anywhere.
    paneEl.addEventListener('mousedown', () => {
      if (paneEl.dataset.sessionId !== state.layout.focusedId) {
        setLayout(layoutStore.focusPane(state.layout, paneEl.dataset.sessionId));
      }
    });
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
    wireComposer(COMMAND_COMPOSER, () => startNewSession(currentTargetDirectory()));
    // Before wireCommandPills, which computes pill visibility from the value.
    restoreComposerDraft(COMMAND_COMPOSER);
    wireCommandPills();
    document.getElementById('command-attach-btn')
      .addEventListener('click', () => browseForFile(COMMAND_COMPOSER));
    document.getElementById('command-slash-btn')
      .addEventListener('click', () => openSlashFromButton(COMMAND_COMPOSER));

    document.getElementById('backlog-add-btn').addEventListener('click', () => {
      const input = document.getElementById('backlog-input');
      const folderSelect = document.getElementById('backlog-folder-select');
      const prioritySelect = document.getElementById('backlog-priority-select');
      const repoPath = (folderSelect && folderSelect.value) || currentTargetDirectory();
      const priority = (prioritySelect && prioritySelect.value) || 'medium';
      addBacklogItem(input.value.trim(), repoPath, priority).then(() => {
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

    // Panes are wired individually as they're cloned from the template — see
    // wirePane, called from renderPanes. Nothing detail-* remains here.
    wireDividerDrag();
    document.getElementById('layout-ctl').addEventListener('click', () => {
      let next = state.layout;
      for (let i = 1; i < next.panes.length; i += 1) {
        next = layoutStore.resizePane(next, next.panes[i - 1].sessionId, 1, next.panes[i].sessionId, 1);
      }
      setLayout(next);
    });

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
      await loadSessions();

      // Restore whichever panes were open at last reload, dropping any
      // session the server no longer reports.
      let rawLayout = null;
      try { rawLayout = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null'); } catch { rawLayout = null; }
      setLayout(layoutStore.hydrate(rawLayout, state.sessions.map((s) => s.id), { max: currentPaneCap() }));
      for (const id of openSessionIds()) { loadChatMessages(id); watchSession(id); }
      // renderSessions() already ran inside loadSessions() above, before this
      // hydrate — the card grid needs one more pass so the restored pane's
      // card shows active immediately rather than waiting for the next poll.
      syncActiveCards();

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
