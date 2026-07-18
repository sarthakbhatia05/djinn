// public/app.js
(function () {
  const state = {
    sessions: [],
    projects: [],
    backlog: [],
    recentDirs: [],
    activeDetailId: null,
    selectedDirectory: null,
  };

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
    const sessions = await guarded(fetchJson('/api/sessions'), 'Failed to load sessions');
    if (sessions === null) return;
    state.sessions = sessions;
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
      `${session.projectFolder}${session.gitBranch ? ' · ' + session.gitBranch : ''}`;

    card.classList.toggle('card--active', session.id === state.activeDetailId);
  }

  function renderSessions() {
    const grid = document.getElementById('session-grid');

    if (state.sessions.length === 0) {
      grid.innerHTML = '<div class="empty-state">No sessions found in ~/.claude/projects yet.</div>';
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
    for (const session of state.sessions) {
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
  }

  // ---------- projects sidebar ----------

  function renderProjects() {
    const list = document.getElementById('project-list');
    list.innerHTML = '';
    if (state.projects.length === 0) {
      list.innerHTML = '<div class="empty-state">No projects yet.</div>';
      return;
    }
    for (const project of state.projects) {
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
      row.querySelector('.project-row-name').textContent = project.projectFolder;
      row.querySelector('.project-row-path').textContent = project.projectPath;
      row.querySelector('.row-count').textContent = String(project.sessionCount);
      list.appendChild(row);
    }
  }

  // ---------- backlog ----------

  function renderBacklog() {
    const list = document.getElementById('backlog-list');
    list.innerHTML = '';
    if (state.backlog.length === 0) {
      list.innerHTML = '<div class="empty-state">Nothing queued.</div>';
    } else {
      for (const item of state.backlog) {
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

    const queued = state.backlog.filter((i) => !i.done).length;
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

  // ---------- detail drawer ----------

  function openDetail(sessionId) {
    const session = state.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    state.activeDetailId = sessionId;
    renderDetail(session);
    // reflect the active card highlight without a full grid rebuild
    for (const child of document.getElementById('session-grid').children) {
      if (child.dataset) child.classList.toggle('card--active', child.dataset.sessionId === sessionId);
    }
  }

  function renderDetail(session) {
    const drawer = document.getElementById('detail-drawer');
    drawer.style.display = 'flex';
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
      `${session.projectFolder}${session.gitBranch ? ' · ' + session.gitBranch : ''}`;
  }

  function updateOpenDetailIfPresent() {
    if (!state.activeDetailId) return;
    const session = state.sessions.find((s) => s.id === state.activeDetailId);
    if (session) renderDetail(session);
  }

  function closeDetail() {
    state.activeDetailId = null;
    const drawer = document.getElementById('detail-drawer');
    drawer.style.display = 'none';
    for (const child of document.getElementById('session-grid').children) {
      if (child.dataset) child.classList.remove('card--active');
    }
  }

  async function sendDetailMessage(message) {
    if (!state.activeDetailId) return;
    if (!message || !message.trim()) {
      showToast('Type a message before sending.');
      return;
    }
    const result = await guarded(
      fetchJson(`/api/sessions/${state.activeDetailId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      }),
      'Failed to send message to session'
    );
    if (result === null) return;
    await loadSessions();
  }

  // ---------- new-session directory picker + command bar ----------

  function currentTargetDirectory() {
    return state.selectedDirectory || state.recentDirs[0] || (state.projects[0] && state.projects[0].projectPath) || null;
  }

  function updateCommandBarHint() {
    const hint = document.querySelector('.command-bar-hint-text');
    if (!hint) return;
    const dir = currentTargetDirectory();
    hint.textContent = dir
      ? `issue a command — I'll route it to an agent, running in: ${dir}`
      : `issue a command — pick a directory with "+ New session" first`;
  }

  function openNewSessionMenu() {
    document.getElementById('new-session-menu').hidden = false;
  }

  function closeNewSessionMenu() {
    document.getElementById('new-session-menu').hidden = true;
  }

  function toggleNewSessionMenu() {
    const menu = document.getElementById('new-session-menu');
    menu.hidden = !menu.hidden;
  }

  function selectDirectory(dir) {
    state.selectedDirectory = dir;
    updateCommandBarHint();
    closeNewSessionMenu();
    // reflect selection in the recent-directories list
    const list = document.getElementById('recent-directories-list');
    for (const item of list.children) {
      const isSelected = item.dataset.dir === dir;
      item.style.background = isSelected ? 'var(--accent-soft)' : '';
    }
  }

  async function loadRecentDirectories() {
    const dirs = await guarded(fetchJson('/api/directories/recent'), 'Failed to load recent directories');
    if (dirs === null) return;
    state.recentDirs = dirs;
    const list = document.getElementById('recent-directories-list');
    list.innerHTML = '';
    for (const dir of dirs) {
      const item = document.createElement('div');
      item.className = 'menu-item';
      item.dataset.dir = dir;
      item.innerHTML = `<span class="status-dot dir-status-dot"></span><span class="dir-path mono"></span>`;
      item.querySelector('.dir-path').textContent = dir;
      item.addEventListener('click', () => selectDirectory(dir));
      list.appendChild(item);
    }
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
      showToast('Pick a directory first — click "+ New session" and choose one.');
      openNewSessionMenu();
      return;
    }
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
    await Promise.all([loadSessions(), loadProjects(), loadRecentDirectories()]);
  }

  // ---------- WebSocket ----------

  function connectWebSocket() {
    const scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const ws = new WebSocket(`${scheme}${location.host}`);
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'session-status') {
        loadSessions();
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
    for (const project of state.projects) {
      const option = document.createElement('option');
      option.value = project.projectPath;
      option.textContent = project.projectFolder;
      select.appendChild(option);
    }
    if (previous && state.projects.some((p) => p.projectPath === previous)) {
      select.value = previous;
    }
  }

  // ---------- header stats ----------

  function updateHeaderStats() {
    const runningCount = state.sessions.filter((s) => s.isRunning).length;
    const runningEl = document.getElementById('running-count-value');
    if (runningEl) runningEl.textContent = String(runningCount);

    const allCountEl = document.getElementById('all-sessions-count');
    if (allCountEl) allCountEl.textContent = String(state.sessions.length);

    const subEl = document.getElementById('section-header-sub');
    if (subEl) {
      const repoCount = state.projects.length;
      subEl.textContent = `${runningCount} agent${runningCount === 1 ? '' : 's'} active across ${repoCount} repo${repoCount === 1 ? '' : 's'}`;
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

  // ---------- wiring ----------

  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('new-session-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleNewSessionMenu();
    });
    document.addEventListener('click', (e) => {
      const wrap = document.querySelector('.new-session-wrap');
      if (wrap && !wrap.contains(e.target)) closeNewSessionMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeNewSessionMenu();
        closeDetail();
      }
    });

    document.getElementById('browse-directory-btn').addEventListener('click', browseForDirectory);
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

    document.getElementById('detail-close-btn').addEventListener('click', closeDetail);
    const detailInput = document.querySelector('#detail-drawer .detail-send-input');
    const detailSendBtn = document.querySelector('#detail-drawer .detail-send-btn');
    detailSendBtn.addEventListener('click', () => {
      sendDetailMessage(detailInput.value);
      detailInput.value = '';
    });
    detailInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') detailSendBtn.click();
    });

    loadSessions();
    loadProjects();
    loadBacklog();
    loadRecentDirectories();
    loadMemoryCommon();
    connectWebSocket();
  });
})();
