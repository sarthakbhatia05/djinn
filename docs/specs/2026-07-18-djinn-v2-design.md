# Djinn v2 — Design

Agreed 2026-07-18. This is the condensed spec for the v2 work; conversation-level detail lives in the session that produced it.

## Identity & open source

- Project name: **Djinn** ("summon a coding agent, phrase your wish carefully"). `package.json` → `djinn`.
- MIT license, new README (what it is, screenshot, install/run, `~/.claude` read-only usage, loopback-bind security note, `isRunning` limitation).
- De-personalize `design/` and `docs/superpowers/` (internal project names + `D:\Projects\...` paths → placeholders); move `docs/superpowers/` → `docs/history/`.
- The `claude` CLI remains the engine; README states this plainly.

## First-run onboarding

- `data/settings.json` (via `jsonStore`): `{ assistantName, onboardedAt, projects: [absolutePath, ...] }`.
- Routes: `GET /api/settings`, `PUT /api/settings`.
- No `assistantName` → full-screen overlay:
  - **Step 1 — naming.** Orb materializes; "What will you call your djinn?"; single input; pulse-burst on confirm.
  - **Step 2 — tracked projects.** Checkable list of projects discovered in `~/.claude/projects` (resolved paths + session counts) plus "add another path…" input. Skipping selects nothing.
- Assistant name replaces every user-visible "Claude"/"Claude Code" string (header, empty states, toasts, running status, chat labels) via one substitution helper. Renameable from the header.

## Tracked projects (allowlist)

- Sessions list, backlog repo-tagging, and per-project memory filter to `settings.projects`.
- Untracked sessions don't render; nothing on disk changes — always reversible.
- "Projects" affordance in header reopens the picker (shows untracked count as a quiet hint).
- Starting a new session in an untracked directory auto-adds it.
- Empty allowlist → empty-state dashboard pointing at the Projects button.

## The living orb

- CSS-only (layered radial gradients, blur, keyframe drift). Breathes when idle; pulses faster/brighter when any session runs (driven by active-run count).
- Large on onboarding; ~28px in the dashboard header next to the assistant name as a global activity indicator.
- `prefers-reduced-motion` → static gradient.

## Chat view

Server:
- `sessionStore.readMessages(sessionId)` — parse full transcript `.jsonl` → `{role: 'user'|'assistant', text, timestamp}`; reuse wrapper-artifact filtering from the title scanner (skip `isMeta`, command wrappers, tool-result arrays). Tool calls collapse to `{role:'assistant', kind:'tool', text:'Ran Bash: npm test'}`.
- `GET /api/sessions/:id/messages`.
- Watch + push over the existing WebSocket: client sends `{type:'watch', sessionId}`; server `fs.watch`es that transcript and pushes `{type:'transcript-update', sessionId}`; client re-fetches (fetch-on-nudge). Drop watch on `unwatch`/disconnect.

UI:
- Clicking a session opens a chat panel (replaces detail drawer content): scrollable history, user right-aligned, assistant left with orb-dot avatar, code blocks preserved, **safe-text path only — never `innerHTML` for message content**.
- Composer posts to existing `POST /:id/message`; "(name) is working…" indicator while running.

## Cross-platform folder picker

- Windows: PowerShell dialog (as today). macOS: `osascript`. Linux: `zenity`, fallback `kdialog`.
- No dialog available → validated typed-path input (server checks directory exists). Recent-directories dropdown carries the flow everywhere.

## Load-bearing fixes (only these; rest of roadmap deferred)

1. `sessionStore` concurrent-deletion race — try/catch the inner readdir loop, skip dead folders.
2. Guard unresolved projects (`pathResolved: false`) before spawn / memory-store use; return a real error.

## Testing

`node --test` coverage for: settings route, `readMessages` parsing (incl. wrapper filtering), watch/unwatch lifecycle (fake watcher), picker fallback. UI verified by running the app (`get_page_text` / `javascript_tool`; screenshots unreliable here).
