# Djinn

A local web app that gives one screen for managing Claude Code sessions across multiple projects: see every session with status and last activity, open a chat view for any of them, start a new session in a chosen directory, send follow-up instructions, keep a repo-tagged backlog, and edit shared + per-project memory.

The project is named **Djinn** (`package.json` → `djinn`); `README.md` is the outward-facing description. On first run the user names their own assistant, and that name — not "Claude" — is what the UI says. The `claude` CLI remains the engine; Djinn reads its transcripts and spawns it.

Status: **working locally, MIT licensed, published to a private GitHub repo (`sarthakbhatia05/djinn`) on branch `master`.**

`design/` and `docs/` are deliberately gitignored — the roadmap, specs and mockups stay on this machine and are not in the repo, so don't go looking for them in a fresh clone and don't add them back. `docs/ROADMAP.md` is still the local record of what's next.

## Run it

```bash
npm install
npm start          # http://127.0.0.1:4317
npm test           # 215 tests
```

## Critical conventions — read before editing

**Tests: `npm test` runs bare `node --test`.** Do NOT "fix" it to `node --test test/` — passing a directory argument throws `MODULE_NOT_FOUND` on this Windows/Node 22 setup. The bare form discovers `test/` correctly.

**`~/.claude.json` is READ-ONLY.** This is Claude Code's own project registry and Claude Code owns writes to it. We read it (via `readJson`) to resolve encoded folder names back to absolute paths. Never write to it — hand-editing it has caused real damage before. `sessionStore` degrades to `pathResolved: false` if it can't be read or parsed.

**The server binds `127.0.0.1` deliberately.** It has no auth and exposes `POST /api/sessions {cwd, message}`, which spawns a Claude Code agent in an arbitrary directory. Binding `0.0.0.0` would make that unauthenticated remote code execution for anyone on the same network. Do not change the bind without adding auth.

**CommonJS only** (`require`/`module.exports`), no ESM, no bundler, no build step.

**Exactly two production dependencies: `express` and `ws`.** Adding a third needs a real justification.

**Never render user-supplied text with `innerHTML`.** Session titles and backlog titles come from user prompts. Use the safe-text path in `public/app.js`; `innerHTML` is only for static template literals.

**No user-visible string says "Claude".** The user named their assistant during onboarding, and every message about it goes through the `assistantName()` helper in `public/app.js` (falls back to `"Assistant"` when unset). Hardcoding "Claude" in a toast, empty state, or status label breaks that illusion. Naming the `claude` CLI as the underlying engine is fine — that's a fact about the tool, not the persona.

## Architecture

```
Browser (public/)  <-- HTTP + WebSocket -->  Local server (server/)
                                              - scans ~/.claude/projects/**/*.jsonl
                                              - reads ~/.claude.json (read-only)
                                              - spawns the `claude` CLI
                                              - owns data/ (backlog, memory, settings, recents)
```

- `server/app.js` — `createApp(deps)`. Pure dependency injection: it constructs nothing itself, so tests inject fakes. Real wiring lives only in `server/index.js`.
- `server/lib/` — one responsibility each, in rough dependency order:
  - Persistence: `jsonStore` (the single persistence primitive — everything below that writes goes through it), `settingsStore`, `backlogStore`, `memoryStore`, `recentDirectories`.
  - Claude Code integration: `pathEncoding` (folder-name encoding), `sessionStore` (transcript scanning), `claudeCli` (process spawning), `claudeUserConfig` (read-only `~/.claude.json` access), `transcriptWatcher` (`fs.watch` + throttle, pushes chat updates over the WebSocket), `slashCommands`, `mcpStatus`.
  - Pickers and plumbing: `folderPicker`, `filePicker` (the `@` file picker), `asyncHandler` (the one place route errors are turned into responses — wrap every async handler in it).
- `server/routes/` — thin HTTP wrappers over the stores, one file per resource: `sessions`, `backlog`, `memory`, `settings`, `projects`, `directories`, `commands`, `mcp`, `claudeConfig`.
- `public/` — `index.html` (shell), `styles.css` (design tokens + the CSS-only orb), `format.js` and `sessionSelect.js` (both shared with Node tests via a guarded export), `app.js` (all behavior).
- `data/` — gitignored runtime state. Never commit it; it holds the user's real backlog, memory, and settings.

## Domain gotchas (each cost real debugging time)

**Session transcript paths.** Claude Code stores transcripts at `~/.claude/projects/<encoded-path>/<session-id>.jsonl`, where the encoding replaces `:`, `\`, `/`, space **and `.`** with `-`. Registry keys in `~/.claude.json` vary in case and slash direction for the same project, so resolution matches case-insensitively.

The dot is the one that bites. This file used to omit it, and so did `encodeProjectPath` — which silently broke every project under the home directory of a Windows account whose username contains a dot (`C:\Users\jane.doe\…`). The encoded name never matched the real folder, so the project resolved to nothing, reported `pathResolved: false`, and its sessions were filtered out of the dashboard entirely. If you are ever unsure whether a character is encoded, check the folder names on disk: none of them should contain that character literally.

**Resolution has two sources, not one.** `~/.claude.json` is the CLI's own registry and only lists projects the CLI knows about — a directory the dashboard itself started a session in may never appear there. `createSessionStore` therefore also takes `extraProjectPaths`, wired in `server/index.js` to the tracked-projects list, so a session we created is resolvable even when the registry has never heard of the folder. Without that second source those sessions are invisible in the dashboard *and* un-continuable.

**Session titles are ~15KB deep, not at the top.** Real user messages have `isMeta: undefined` (not `false` — checking `=== false` matches nothing and yields zero titles). The first several `type:"user"` lines are wrapper artifacts (`<local-command-caveat>`, `<command-name>`, `<system-reminder>`) and tool-result arrays, all of which must be skipped. `READ_HEAD_BYTES` is 64KB because measured real-prompt offsets across 162 transcripts were p50 10.5KB / p99 25.2KB / max 52.9KB; 8KB resolved 12/162, 64KB resolves ~145/162, and larger budgets gain nothing. Head parses are cached by mtime+size (~10x faster on repeat requests).

**Windows atomic writes need retries.** `jsonStore.writeJson` writes to `.tmp` then renames. On Windows that rename intermittently fails with `EPERM` when antivirus or the search indexer briefly holds a handle — roughly 1 run in 6 under rapid writes. It retries 5 times with escalating backoff on `EPERM`/`EACCES`/`EBUSY` only. Don't remove the retry.

**Long agent runs.** `--print` blocks until the agent finishes, so `requestTimeout`/`headersTimeout` are set to 0. Node's 300s default would otherwise abort the HTTP request while the child process kept running.

## Known limitation

`isRunning` only reflects sessions the dashboard itself spawned. Sessions started in a terminal show their history but never light up as running — there's no reliable on-disk "is running" flag. New sessions spawned from the dashboard are counted via `GET /api/sessions/active-count`, because their real session id isn't known until the CLI returns.

## Verifying UI changes

Run the app and look at it — tests don't cover DOM wiring. Note that the browser `computer` screenshot action and `read_page` have been unreliable in this environment; `get_page_text`, `javascript_tool` DOM inspection, and `read_console_messages` work fine.

Don't POST to `/api/sessions` or `/:id/message` during verification unless you mean it — those spawn a real Claude Code agent and consume tokens.
