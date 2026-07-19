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
    drawerSize: readDrawerSize(), // function declarations hoist, so this is fine
    drawerMinimized: false,
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

  async function fetchJson(url, options) {
    const res = await fetch(url, options);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `${res.status} ${res.statusText}`);
    }
    return res.status === 204 ? null : res.json();
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
        row.innerHTML = `
          <input type="checkbox" class="backlog-checkbox" />
          <div class="backlog-row-title"></div>
          <div class="backlog-priority"></div>
          <div class="mono backlog-row-project"></div>
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
    renderDetail(session);
    if (isSwitch) {
      const history = document.getElementById('chat-history');
      if (history) history.innerHTML = '';
      loadChatMessages(sessionId);
      watchSession(sessionId);
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

    drawer.querySelector('.detail-title').textContent = session.title || '(no summary yet)';
    drawer.querySelector('.detail-meta').textContent =
      `${session.projectName || session.projectFolder}${session.gitBranch ? ' · ' + session.gitBranch : ''}`;
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
      bubble.textContent = msg.text; // user/model text — never innerHTML
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

  function closeDetail() {
    if (state.activeDetailId) unwatchSession(state.activeDetailId);
    state.activeDetailId = null;
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

  function readDrawerSize() {
    try {
      const saved = localStorage.getItem(DRAWER_SIZE_KEY);
      return DRAWER_SIZES.includes(saved) ? saved : 'normal';
    } catch {
      return 'normal'; // private mode / storage disabled
    }
  }

  function applyDrawerSize() {
    const drawer = document.getElementById('detail-drawer');
    if (!drawer) return;
    drawer.classList.toggle('drawer--wide', state.drawerSize === 'wide');
    drawer.classList.toggle('drawer--full', state.drawerSize === 'full');
    drawer.classList.toggle('drawer--min', state.drawerMinimized);

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
    try { localStorage.setItem(DRAWER_SIZE_KEY, state.drawerSize); } catch { /* non-fatal */ }
    applyDrawerSize();
  }

  function toggleDrawerMinimized() {
    state.drawerMinimized = !state.drawerMinimized;
    applyDrawerSize();
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
        body: JSON.stringify({ message }),
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
    const result = await guarded(
      fetchJson('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, message }),
      }),
      'Failed to start session'
    );
    if (result === null) return;
    input.value = '';
    showToast(`${assistantName()} finished the run — session added.`, false);
    await Promise.all([loadSessions(), loadProjects(), loadRecentDirectories()]);
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

  async function loadMemoryCommon() {
    const result = await guarded(fetchJson('/api/memory/common'), 'Failed to load common memory');
    if (result === null) return;
    document.getElementById('memory-common-text').value = result.text || '';
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
    if (result !== null) showToast('Common memory saved.', false);
  }

  async function loadMemoryProject(projectPath) {
    const textarea = document.getElementById('memory-project-text');
    if (!projectPath) {
      textarea.value = '';
      return;
    }
    const result = await guarded(
      fetchJson(`/api/memory/project?path=${encodeURIComponent(projectPath)}`),
      'Failed to load project memory'
    );
    if (result === null) return;
    textarea.value = result.text || '';
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
    if (result !== null) showToast('Project memory saved.', false);
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

    // The header orb is the global activity indicator: it breathes when idle
    // and pulses while anything runs.
    const orb = document.getElementById('header-orb');
    if (orb) orb.classList.toggle('orb--active', runningCount > 0);

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
      document.querySelector('.command-bar'),
      document.querySelector('.section-header'),
      document.querySelector('.sessions-eyebrow'),
      document.getElementById('session-grid'),
      document.querySelector('.section-label-row'),
      document.querySelector('.backlog-add-row'),
      document.getElementById('backlog-list'),
    ].filter(Boolean);
  }

  function showSessionsView() {
    for (const el of mainViewSections()) el.style.display = '';
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

  // ---------- the living orb (3D particle cloud) ----------
  //
  // Each .orb container (except the tiny .orb--dot beads) gets a canvas with
  // a true-3D particle sphere: points spread over a sphere with a fibonacci
  // lattice, rotated around a tilted axis and perspective-projected every
  // frame. Depth drives size and opacity, so the cloud visibly turns in 3D.
  // `.orb--active` (any session running) speeds the spin and brightens the
  // cloud; `.orb--burst` (naming celebration) fires a one-shot expansion.

  const orbRenderers = [];
  let orbPalette = null;

  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(full, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function getOrbPalette() {
    if (orbPalette) return orbPalette;
    const accentValue = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#d97757';
    const accent = accentValue.startsWith('#') ? hexToRgb(accentValue) : { r: 217, g: 119, b: 87 };
    // near-white warm tint for the front-most particles
    const bright = {
      r: Math.round(accent.r + (255 - accent.r) * 0.65),
      g: Math.round(accent.g + (255 - accent.g) * 0.6),
      b: Math.round(accent.b + (255 - accent.b) * 0.55),
    };
    orbPalette = { accent, bright };
    return orbPalette;
  }

  function rgba(c, a) {
    return `rgba(${c.r},${c.g},${c.b},${a})`;
  }

  function makeOrbRenderer(container) {
    const canvas = document.createElement('canvas');
    container.appendChild(canvas);
    const particles = [];
    const count = 230;
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < count; i += 1) {
      const y = 1 - (i / (count - 1)) * 2;
      const rad = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = golden * i;
      particles.push({
        x: Math.cos(theta) * rad,
        y,
        z: Math.sin(theta) * rad,
        twinkleSpeed: 0.6 + Math.random() * 2.2,
        twinklePhase: Math.random() * Math.PI * 2,
        sizeJitter: 0.55 + Math.random() * 1.0,
      });
    }
    return {
      container,
      canvas,
      ctx: canvas.getContext('2d'),
      particles,
      angle: Math.random() * Math.PI * 2,
      speed: 0.18,
      pixelSize: 0,
      burstStartedAt: 0,
    };
  }

  function drawOrb(o, dt, now, animate) {
    const el = o.container;
    if (el.offsetWidth === 0) return; // hidden (e.g. onboarding step not shown)

    const dpr = window.devicePixelRatio || 1;
    const pixelSize = Math.round(el.offsetWidth * 1.5 * dpr);
    if (pixelSize <= 0) return;
    if (o.pixelSize !== pixelSize) {
      o.pixelSize = pixelSize;
      o.canvas.width = pixelSize;
      o.canvas.height = pixelSize;
    }

    const active = el.classList.contains('orb--active');
    if (el.classList.contains('orb--burst') && !o.burstStartedAt) {
      o.burstStartedAt = now;
      setTimeout(() => {
        el.classList.remove('orb--burst');
        o.burstStartedAt = 0;
      }, 1000);
    }

    // ease the spin speed toward its target so state changes feel organic
    const targetSpeed = active ? 1.1 : 0.18;
    o.speed += (targetSpeed - o.speed) * Math.min(1, dt * 2.5);
    o.angle += o.speed * dt;

    let burstScale = 1;
    if (o.burstStartedAt) {
      const t = (now - o.burstStartedAt) / 1000;
      burstScale = 1 + 0.45 * Math.exp(-t * 3.5) * Math.sin(Math.min(t * 9, Math.PI));
    }

    const { accent, bright } = getOrbPalette();
    const ctx = o.ctx;
    const size = pixelSize;
    const center = size / 2;
    const radius = size * 0.31 * burstScale;

    ctx.clearRect(0, 0, size, size);

    // soft core glow behind the cloud
    const glow = ctx.createRadialGradient(center, center, 0, center, center, radius * 1.2);
    glow.addColorStop(0, rgba(accent, active ? 0.30 : 0.16));
    glow.addColorStop(1, rgba(accent, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, size, size);

    const sinA = Math.sin(o.angle);
    const cosA = Math.cos(o.angle);
    const tilt = 0.42; // fixed axis tilt so the spin reads as 3D
    const sinT = Math.sin(tilt);
    const cosT = Math.cos(tilt);
    const seconds = now / 1000;
    const dotScale = size / 190;

    for (const p of o.particles) {
      // rotate around the vertical axis…
      const x = p.x * cosA + p.z * sinA;
      const z = -p.x * sinA + p.z * cosA;
      // …then tilt the whole sphere forward
      const y2 = p.y * cosT - z * sinT;
      const z2 = p.y * sinT + z * cosT;

      const persp = 1 / (1.65 - z2 * 0.5);
      const px = center + x * radius * persp;
      const py = center + y2 * radius * persp;
      const depth = (z2 + 1) / 2; // 0 = back, 1 = front

      let alpha = 0.10 + 0.8 * depth * depth;
      if (animate) alpha *= 0.72 + 0.28 * Math.sin(seconds * p.twinkleSpeed + p.twinklePhase);
      if (active) alpha = Math.min(1, alpha * 1.3);

      const dotRadius = Math.max(0.4, (0.5 + 1.15 * depth) * p.sizeJitter * dotScale);
      ctx.beginPath();
      ctx.arc(px, py, dotRadius, 0, Math.PI * 2);
      ctx.fillStyle = depth > 0.86 ? rgba(bright, alpha) : rgba(accent, alpha);
      ctx.fill();
    }
  }

  let orbLastFrameAt = 0;
  let orbReducedMotion = false;

  function orbTick(now) {
    const dt = orbLastFrameAt ? Math.min(0.05, (now - orbLastFrameAt) / 1000) : 0.016;
    orbLastFrameAt = performance.now();
    for (const o of orbRenderers) {
      // Reduced motion: each orb gets one static frame the first time it's
      // visible (pixelSize is only set once it has been drawn), then holds.
      if (orbReducedMotion && o.pixelSize !== 0) continue;
      drawOrb(o, dt, now, !orbReducedMotion);
    }
  }

  function orbFrame(now) {
    orbTick(now);
    requestAnimationFrame(orbFrame);
  }

  function initOrbs() {
    for (const el of document.querySelectorAll('.orb')) {
      if (el.classList.contains('orb--dot')) continue;
      orbRenderers.push(makeOrbRenderer(el));
    }
    // theme flips change --accent; drop the cached palette so the next frame
    // picks up the new colors
    new MutationObserver(() => { orbPalette = null; })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    orbReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(orbFrame);
    // Some embedded webviews render the page while reporting it hidden, which
    // suppresses requestAnimationFrame entirely. If frames stall, keep the
    // orb alive at a low rate; when rAF is healthy this never fires. The cost
    // while genuinely hidden is negligible (three small canvases at 10fps).
    setInterval(() => {
      if (performance.now() - orbLastFrameAt > 400) orbTick(performance.now());
    }, 100);
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
        closeDirectoryMenus();
        closeProjectsModal();
        closeDetail();
      }
    });

    wireSessionControls();

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
    document.getElementById('detail-size-btn').addEventListener('click', cycleDrawerSize);
    document.getElementById('detail-minimize-btn').addEventListener('click', toggleDrawerMinimized);
    // A minimized drawer is mostly header, so let the header itself restore it.
    document.querySelector('#detail-drawer .drawer-header').addEventListener('click', (e) => {
      if (state.drawerMinimized && !e.target.closest('.drawer-controls')) toggleDrawerMinimized();
    });
    const detailInput = document.querySelector('#detail-drawer .detail-send-input');
    const detailSendBtn = document.querySelector('#detail-drawer .detail-send-btn');
    detailSendBtn.addEventListener('click', () => {
      sendDetailMessage(detailInput.value);
      detailInput.value = '';
    });
    detailInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') detailSendBtn.click();
    });

    initOrbs();

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
