# Claude Code Dashboard — Design

## Problem

Claude Code sessions are spread across multiple project folders (currently `D:\Projects\DFM-Project\*` and `D:\Projects\Mimo-Monitors\*`, more later). There's no single place to see what's running, what changed last, or queue up work without opening a terminal per project. Existing tools were tried and rejected:

- **Nimbalyst** (open-source Electron app) — covers sessions/tasks/kanban but was judged too complicated for what's needed here.

Decision: build a small custom local dashboard, scoped to only what's actually wanted.

## Goals (v1)

1. See all Claude Code sessions/agents across every tracked project, with live running/idle/needs-input status.
2. Start a new session by picking a working directory — a dropdown of recently-used directories, plus "browse for a different directory."
3. Send a command/instruction to a session (new or existing) from the dashboard.
4. See last activity/output per session at a glance.
5. A backlog/todo board where each item is tagged to a specific repo.
6. Memory: both a **common** (cross-project) memory and a **per-project** memory, editable from the dashboard.
7. Visual style: minimal, futuristic, single-accent, dot-matrix display type in restrained places (eyebrows/labels/counters), full light + dark theme. Reference mockup: `design/dashboard-mockup-v2.html` (approved).

## Non-goals (v1)

- No visual file/markdown/diagram editors (that's Nimbalyst's whole other axis of scope — explicitly not wanted here).
- No multi-user / remote access / auth — single local user, single machine.
- No Electron packaging — runs as a local web app (see Architecture).
- No git worktree management or repo mutation beyond what Claude Code sessions already do themselves.
- No mobile app.

## Architecture

**Shape:** local web app — a small local server process + a browser tab as the UI. No installer, no packaging step. Start it with one command; stop it by closing the process.

```
┌─────────────────────────┐      reads/watches       ┌──────────────────────────────┐
│  Browser tab (frontend)  │ <──── HTTP + WebSocket ──│  Local server (backend)       │
│  session list, todo      │                          │  - scans ~/.claude/projects   │
│  board, memory editor     │                          │  - reads ~/.claude.json       │
└─────────────────────────┘                          │  - shells out to `claude` CLI │
                                                        │  - owns backlog + memory data │
                                                        └──────────────────────────────┘
```

### Data sources (all discovered this session, verified against the real installation)

- **Session transcripts**: `~/.claude/projects/<encoded-path>/*.jsonl`, one folder per project absolute path (path encoded by replacing `:`, `\`, and spaces with `-`). Read-only source for session list, status, and history.
- **Project registry / settings**: `~/.claude.json`, key `projects[<absolute-path>]` — holds `lastSessionId`, `lastSessionFirstPrompt`, token/cost usage, etc. Treat as **read-only** from the dashboard; Claude Code itself owns writes to this file. (We already learned this file is sensitive to hand-edits — back up before any write, and prefer reading over writing here.)
- **Running/live status**: no persisted "is running" flag was found on disk. v1 approach: shell out to `claude --resume <id> --print "<instruction>" --output-format json` to send commands (this returns structured JSON with `session_id`, `result`, `usage`, `cost`, confirmed working), and track "is this session's process currently active" via processes the dashboard itself spawned. Sessions started outside the dashboard (plain terminal `claude`) won't show live "running" state in v1 — only their history. This is a known limitation, called out explicitly so it's not a surprise later.
- **New session / send command**: spawn `claude` (new session) or `claude --resume <id>` (existing session) as a child process from the backend, with `--print --output-format json` for a single instruction, or without `--print` if we want an attachable interactive session (open question for the plan — see Risks).
- **Backlog/todo board**: new data, owned by the dashboard itself. Store as a local JSON or SQLite file in the dashboard's own app-data directory, with each item tagged to a repo (absolute path) and priority.
- **Memory**:
  - *Per-project memory*: surfaced from Claude Code's own project-scoped memory/context if accessible on disk; otherwise a dashboard-owned per-project notes file as a fallback — needs a short investigation during planning to see what's actually readable.
  - *Common memory*: dashboard-owned, one shared notes/context blob visible to every project, not tied to any single repo.

### Frontend

Plain HTML/CSS/JS to start (matches "simpler" — no framework build step required for v1); can grow into something more structured later if the codebase outgrows it. Visual design: see `design/dashboard-mockup-v2.html` — dark/light theme via CSS custom properties, single accent (`#d97757` dark / `#bf5e39` light), dot-matrix type (Silkscreen, DotGothic16) used sparingly for labels/counters, Hanken Grotesk for body, JetBrains Mono for paths/branches. Restore deliberate (not absent) motion: input-bar listening pulse, card hover, a considered load-in — not the heavier sci-fi animation from the first draft.

## Known risks / open questions for the implementation plan

1. **Live "running" detection** for sessions not started by the dashboard itself — needs a concrete answer (poll `.jsonl` mtimes? watch the daemon's control socket at `\\.\pipe\cc-daemon-*-control`, which exists but is undocumented and shouldn't be relied on blindly?).
2. **Concurrent writes to `~/.claude.json`** — we already hit real corruption risk hand-editing this file earlier this session. The dashboard must never write to it; only Claude Code itself should.
3. **Per-project memory source** — confirm what's actually readable on disk before committing to "surface Claude Code's own memory."
4. **Interactive vs. one-shot command dispatch** — `--print` gives clean structured output but ends the process each time; a truly "send a message to a live session and watch it work" experience may need a different invocation mode. Needs a spike.
5. Windows-specific: this whole system already showed real friction with file locks (AV, stale handles) during the `D:\Projects` move — background file-watching on Windows should account for that.

## Success criteria (v1)

- Open one URL, see every session across `D:\Projects\DFM-Project\*` and `D:\Projects\Mimo-Monitors\*` with correct status and last activity.
- Start a new session in a chosen directory (recent-list or browse) from the dashboard, without a terminal.
- Send a follow-up instruction to an existing session from the dashboard and see the result.
- Add a backlog item, tag it to a repo, see it listed under that repo.
- Read and edit both common and per-project memory from the dashboard.
- Toggle light/dark theme; visual style matches the approved mockup.
