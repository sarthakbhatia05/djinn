# Roadmap & Follow-ups

Current state: **v1 complete, 68 tests passing, working locally, not pushed to any remote.**

The decision was made not to push yet — see "Before going open source" below. Nothing is at risk; all work is committed locally.

## Open decisions (needed before first push)

- **Repository name.** Deliberately undecided. Direction: no "claude" in the name, something personal-assistant flavored.
- **License.** Needed before anyone can legally use this. MIT is the usual permissive default.
- **Visibility.** Intent is open source / multi-user. Note that until the de-personalization work below is done, the repo contains internal project names.

## Before going open source

These are the actual blockers to someone else using this.

1. **Cross-platform directory picker.** `server/lib/folderPicker.js` shells out to PowerShell's `System.Windows.Forms.FolderBrowserDialog` — Windows-only. On macOS/Linux the "Browse for a different directory…" button breaks. Either add per-platform implementations (`osascript` on macOS, `zenity`/`kdialog` on Linux) or degrade gracefully to a typed-path input with validation. Whatever the choice, the recent-directories dropdown already works everywhere and can carry the flow.

2. **Remove personal/internal data from the repo.** `design/dashboard-mockup-v2.html` and both files under `docs/superpowers/` reference real internal projects — `DFM-Project`, `Mimo-Monitors`, `oarc-function-app`, `Fuji IoT Python Application`, `admin-rules-batch-function-app` — plus absolute `D:\Projects\...` paths. Replace with generic placeholders before the repo is visible to anyone else.

3. **README.** Doesn't exist yet and is the highest-value missing file: what it does, a screenshot, install/run, the `~/.claude` data it reads, the security note about the loopback bind, and the known `isRunning` limitation.

4. **Reframe `docs/`.** `docs/superpowers/specs/` and `docs/superpowers/plans/` are internal build artifacts (the design spec and the task-by-task implementation plan), not user documentation. Keep them if useful as history, but they shouldn't be what a newcomer lands on.

5. **Path assumptions.** Verify nothing assumes Windows-style paths outside the folder picker — `pathEncoding` handles both separators, but this deserves a pass on a non-Windows machine.

## Product gaps (features that are stubbed or partial)

- **Detail drawer "Agent plan" list** (`#detail-plan-list`) has no data source; the API returns no plan/steps. Either derive steps from the transcript or drop the section.
- **`⌘K` search box is decorative** — it renders as a real affordance but does nothing. Wire it or remove it.
- **Backlog isn't grouped by repo.** Items store and display `repoPath`, but the spec's "see it listed under that repo" implies grouping/filtering; it's currently a flat list.
- **No "needs input" status.** `.card-status-label--needs-input` exists in CSS; nothing ever sets it. Status is currently binary (running/idle).
- **Theme toggle doesn't persist** — no `localStorage`, so every reload resets to the OS preference.
- **No way to cancel a running session** from the UI, and a `claude` process that blocks on a permission prompt hangs indefinitely (no timeout, no kill path).

## Engineering follow-ups

Roughly highest-value first. None are blocking; all were triaged as non-blocking in the final review.

1. **`sessionStore` concurrent-deletion race** — `readdirSync` on a project folder deleted mid-scan throws and aborts the entire session list. Wrap the inner loop in try/catch and skip that folder.
2. **`claudeCli` concurrent same-id sends** — two `sendMessage` calls for one session share a single running-map entry; the first to finish fires `idle` and flips `isRunning` false while the second is still running. Matters more now that `isRunning` is load-bearing.
3. **Unify route error handling.** `sessions.js` wraps errors → 502, `directories.js` → 500, and `backlog.js`/`memory.js`/`projects.js` don't wrap at all — so a store throw returns Express's default HTML 500, which the frontend's `fetchJson` can't parse, producing a confusing toast. One error-handling middleware in `server/app.js` fixes all five.
4. **Stop forwarding `err.message` verbatim** in 502 bodies (`routes/sessions.js`).
5. **Guard unresolved projects.** When `pathResolved` is false, `projectPath` holds an encoded non-path that gets passed as `cwd` to `spawn` (raw `ENOENT`) and used as a memory-store key. Check before dispatch and give a real error.
6. **`PATCH /api/backlog/:id` accepts arbitrary body fields** — `req.body` is spread straight into the item, so a client can overwrite `id` or `createdAt`. Only the intended fields should be writable.
7. **WebSocket reconnect has no backoff or cap** — a down server produces a 3s reconnect loop forever.
8. **Per-request `statSync` cost** — 162 syscalls per `/api/sessions`; `POST /:id/message` does a full `listSessions()` scan just to resolve one id.
9. **Google Fonts loaded from CDN** in an otherwise local-first app — offline start silently degrades the typography. Consider self-hosting the four faces.
10. **Test-coverage debt** — untested branches: `POST /api/sessions/:id/message` 400, `PUT /api/memory/project` 400, `/api/directories/browse` error + cancel paths, `PATCH /api/backlog/:id` success; no assertions on backlog `id`/`createdAt`.
11. **Minor cleanups** — `folderPicker` can't distinguish a failed dialog from a user cancel (both yield null); `backlogStore.remove()` rewrites the file even when the id is absent; empty-string `gitBranch` treated as absent; `claudeCli` accumulates stdout via string concat so a multi-byte UTF-8 char split across chunks could mis-decode; `client.OPEN` read off the instance rather than the `WebSocket` constant.

## Unrelated local cleanup (from the earlier project consolidation)

- `D:\Mimo-Monitors\Fuji IoT Python Application` — empty leftover folder, was file-locked at the time; delete once the lock clears.
- `~fuji-venv` needs regenerating at its new location: `python3 -m venv ~fuji-venv && pip install -r requirements.txt`.
