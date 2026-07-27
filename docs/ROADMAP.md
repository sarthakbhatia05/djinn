# Roadmap & Follow-ups

Current state: **210 tests passing, working locally, still no git remote.** The
composer redesign, the project-path resolution fixes and the command pills sit
on branch `composer-redesign` (4 commits), not merged to `master`.

Since the last revision of this file, most of the original blockers closed:
cross-platform folder picker, README, unified route error handling, theme
persistence, session cancel, a wired `⌘K` quick switcher, backlog `PATCH`
field whitelisting, MCP status, slash commands, and the `@` file picker all
shipped. What follows is what's actually left.

Ordering within each section is roughly highest-value first.

**Keeping this file honest.** Every revision so far has drifted — this one
found two section 5 items that were fixed in code but still listed as open,
plus a claim written the same day that was already wrong. Before editing,
verify each item you touch against the code rather than against this file.

---

## 1. Dead UI — things that advertise as interactive and aren't

These cost the most trust per line of code, because a user clicks them and
nothing happens. Each is either a small wiring job or a deletion.

- ~~The four command pills are unwired.~~ **Shipped.** They fill the composer
  with a starting scaffold and place the caret where you continue typing, then
  hide themselves while the composer has content — which is what lets a click
  replace the value without a confirm. Converted to `<button>` in the same
  change.

- **No "needs input" status.** `.card-status-label--needs-input` exists in CSS
  and nothing ever sets it. Status is binary running/idle, so a session
  blocked on a permission prompt is visually identical to a finished one.
  That matters specifically because a `claude` process blocked on a prompt
  hangs indefinitely — there's no timeout and no kill path except the drawer's
  Stop button, which the user has no reason to reach for if the session looks
  merely idle.

---

## 2. The composer — highest-frequency interaction in the app

Every session starts and continues here, so friction compounds.

- ~~Both prompt inputs are single-line `<input>`.~~ **Shipped.** Both are now
  `<textarea rows="1">` with auto-grow (`autoGrowComposer`), capped at 220px
  with a scrollbar past that. Enter sends, Shift+Enter breaks the line.

- ~~Composer feature parity is inverted.~~ **Shipped.** The slash and attach
  machinery is written against a composer context object (`COMPOSERS` in
  `app.js`), so `@` and `/` exist in both surfaces from one implementation.
  The command bar resolves its project path from the chosen directory where
  the drawer resolves it from the open session; that is the only difference.

- ~~Drawer footer layout and control styling.~~ **Shipped** — see section 6.

- **No prompt history.** No ↑-arrow recall in either input. Re-running a
  tweaked variant of a prompt means retyping it from scratch.

- **No draft persistence.** Type a long prompt, click a session card, come
  back — it's gone. `localStorage` per session id would cover it.

---

## 3. Features users actually reach for

- **Copy buttons — none anywhere.** There is no clipboard call in `app.js` at
  all. Fenced code blocks get rendered by `splitFencedCode` with no way to
  copy them; likewise no copy on project path, session id, or an assistant
  message.

- **Session cards have exactly one action.** `buildCardSkeleton` binds a
  single click → `openDetail`. No hover or context menu for: copy path, open
  in editor, resume in terminal, rename, archive/hide, delete. With 81
  sessions in a normal install and no delete path, the list only grows.

- **No transcript search.** `⌘K` matches session *titles* only. The actual
  retrieval need at 80+ sessions is "find the session where I discussed X",
  which needs full-text search across transcript bodies. Server-side, this is
  a grep across the `.jsonl` files with the existing mtime+size cache in
  front of it.

- **No completion notification.** `document.title` is only ever set to the
  assistant name, and the `Notification` API is unused. Because `--print`
  blocks until the agent finishes, long runs are exactly when the user tabs
  away — and nothing tells them it's done. A `(1)` title badge plus an opt-in
  desktop notification is small and disproportionately useful here.

- **Cost/usage tracking.** Built and then reverted (`285da7d`, reverted in
  `0f06c01`). It derived per-session and all-time spend from the
  `total_cost_usd`/`usage` fields the CLI already returns on every call, so
  the data is free — no extra API surface. Worth revisiting; the reason for
  the revert isn't recorded in the commit message.

- **Backlog is thin.** Priority renders as a static `.backlog-priority` div
  with no editor. Still ungrouped by repo despite every item storing
  `repoPath`. No reordering, no due dates.

---

## 4. Robustness

- **Zero `@media` queries.** Not one in ~1800 lines of CSS. The layout is a
  fixed sidebar + main + drawer with no reflow path, so a laptop screen with
  the drawer widened, or a split window, has no defined behavior. Minimum
  viable fix is one breakpoint that collapses the sidebar.

- **Interactive `<div>`s that should be `<button>`s.** Partly done: the four
  drawer/modal controls (`#detail-minimize-btn`, `#detail-size-btn`,
  `#detail-close-btn`, `#projects-modal-close`) are real buttons with
  `aria-label`s, which is what let the `.drawer-ctl` UA-chrome reset stop
  being an apology and become ordinary button styling. The four `.pill`s went
  with them. Verified still `<div>`s: `#new-session-btn`, `#projects-btn`, the
  theme toggle, and every `.row` (`app.js:540`) and `.menu-item`
  (`app.js:1959`). None are keyboard-focusable or announced, and `aria-`
  coverage outside the composer and those controls is still zero.

- **No favicon.** `index.html` declares none, so the browser tab shows the
  blank-page icon. Trivial, and this is an app that lives in a pinned tab.

---

## 5. Engineering follow-ups

Carried forward from the previous revision; none are blocking.

1. ~~**`sessionStore` concurrent-deletion race.**~~ **Already fixed** — the
   inner loop is wrapped and skips the folder (`sessionStore.js`, the
   `catch { continue; }` blocks), with a ghost-folder test covering it. This
   entry was stale; verified 2026-07-27.
2. **`claudeCli` concurrent same-id sends** — two `sendMessage` calls for one
   session share a single running-map entry; the first to finish fires `idle`
   and flips `isRunning` false while the second is still running.
   **Still open at the server level.** The composer now refuses to send to a
   running session, so the UI no longer *walks* into it — but that is a client
   guard on one path, not a fix. A second browser tab, a direct `curl`, or the
   queue feature in section 6 all still reach it.
3. ~~**Stop forwarding `err.message` verbatim** in 502 bodies.~~ **Already
   fixed** — `server/app.js:48` only passes `err.message` through for statuses
   below 500. This entry was stale; verified 2026-07-27.
4. **Guard unresolved projects.** When `pathResolved` is false, `projectPath`
   holds an encoded non-path that gets passed as `cwd` to `spawn` (raw
   `ENOENT`) and used as a memory-store key. Check before dispatch and return
   a real error.

   **Fixed 2026-07-27.** Two causes, both now closed — see the commit. The
   write-up below is kept because the diagnosis is the useful part.

   **Worse symptom, reproduced 2026-07-27:** start a session in a directory
   that isn't in `~/.claude.json` and *the dashboard's own new session becomes
   permanently invisible in it.* `POST /api/sessions` succeeds, the transcript
   is written, and `settingsStore.addProject(cwd)` adds the real absolute path
   to the allowlist — but `sessionStore` can't resolve that folder, so
   `projectPath` comes back as the encoded folder name
   (`C--Users-...-djinn-verify`). The tracked filter in `routes/sessions.js`
   then compares `normalizePath(encoded)` against `normalizePath(absolute)`,
   they never match, and the session is filtered out of `GET /api/sessions`
   forever. Three real sessions were created this way and none appeared.

   Note the trap: the obvious "fix" is to register the directory in
   `~/.claude.json`, which we must never write. The fix belonged on our side,
   and turned out to be two separate defects stacked on each other:

   1. `createSessionStore` resolved folder names against the CLI registry only.
      It now also takes `extraProjectPaths`, wired to the tracked-projects
      list, so a directory we were handed at session-creation time stays
      resolvable even when the registry has never heard of it.
   2. **`encodeProjectPath` never encoded `.`** — the larger bug, found only
      because fix 1 still didn't work. Claude Code replaces dots with hyphens;
      we didn't, so any path containing one produced a name that could never
      match its folder. On a Windows account named `sarthak.bhatia.INTIMETEC`
      that is *every project under the home directory*. Confirmed against the
      real install: 0 of 100+ transcript folders contain a literal dot.

   After both: the 3 previously-invisible sessions resolve, and
   `pathResolved: false` no longer occurs anywhere in the list.
5. **WebSocket reconnect has no backoff or cap** — a down server produces a
   3s reconnect loop forever.
6. **Per-request `statSync` cost** — ~162 syscalls per `/api/sessions`;
   `POST /:id/message` runs a full `listSessions()` scan just to resolve one
   id.
7. **Google Fonts loaded from CDN** in an otherwise local-first app — offline
   start silently degrades typography. Consider self-hosting the four faces.
8. **Minor cleanups** — `backlogStore.remove()` rewrites the file even when
   the id is absent; empty-string `gitBranch` treated as absent; `claudeCli`
   accumulates stdout via string concat, so a multi-byte UTF-8 char split
   across chunks could mis-decode; `client.OPEN` read off the instance rather
   than the `WebSocket` constant.

9. **The error middleware never logs.** `server/app.js` correctly refuses to
   leak `err.message` to the client on a 5xx — and then drops it entirely.
   Nothing is written server-side, so a 500 gives you `{"error":"Internal
   server error"}` in the browser and an empty terminal. Hit for real on
   2026-07-27: a `POST /api/sessions` returned 500 in 0.4s and the only way to
   see `spawn claude ENOENT` was to re-run `claudeCli.startSession` by hand in
   a REPL. One `console.error(err)` in the handler fixes it. This is the
   highest value-per-line item in this section.

10. **Intermittent `spawn claude ENOENT` on session start.** Same day, the
    first `POST /api/sessions` after a server start failed this way; every
    identical request afterwards succeeded. `claude.exe` was on `PATH` and
    `PATHEXT` was populated in both shells checked. Not diagnosed, not
    reproduced since. Filed so the next occurrence isn't treated as new. Item
    9 is a prerequisite for investigating it.

11. **Slash popup can be closed by the wrong composer's blur.** `wireComposer`
    binds `blur → closeSlashPopup()`, which closes whichever popup is open
    rather than only its own. Hand-off *between* composers is handled
    (`handleComposerSlash` closes the outgoing one), so the reachable case is
    narrow, but the blur handler is still not context-aware.

---

## 6. Composer redesign — **shipped**

Measured after the change, at the same default 360px drawer width: the rail is
**one row** (it can no longer wrap — 6px of slack remain at the tightest
setting), the footer is **81px** instead of 128px, and `appearance: none` on
the selects removed the last native OS chrome in the app. The command bar got
the identical treatment, so the two composers share one stylesheet component
(`.composer`) and one behaviour module (`COMPOSERS`).

Landed in this pass:

- Unified container, ghost controls, lowercase mono labels — as specified below
- `<textarea>` + auto-grow in both surfaces; Enter sends, Shift+Enter newlines
- `/` button in both surfaces, `@` extended to the command bar
- Send becomes Stop in place while running; the selects and MCP chip give way
  to a working indicator. **This closed a live bug** — `#detail-send-btn` had
  no `isRunning` wiring, so a second message could be fired at a busy agent and
  land both sends on one entry in `claudeCli`'s running map (section 5 item 2).
  Enter deliberately never stops a session; only the button does.
- The command bar got the matching in-flight state. `POST /api/sessions` blocks
  until the agent finishes, so it can be outstanding for minutes with nothing on
  screen to say so — an impatient second click spawned a second agent in the
  same directory. It disables rather than turning into Stop: the CLI hasn't
  returned a session id yet, so there is nothing to cancel *by*.
- MCP is a status chip that remembers its last check per project, still never
  auto-fetching (`claude mcp list` costs ~15s)
- The header's separate Stop button is gone — one Stop, in the composer
- `--hover` token added: the ghost controls sit on several surfaces, so a
  hover that named a surface token would need to brighten in dark and darken
  in light

Deferred from the original spec: ambient per-session cost in the rail (needs
the `285da7d` unrevert).

**Still undecided: the send glyph.** It ships as the `↑` disc because that is
what the approved layout sketch showed, but that was a default taken to avoid
blocking, not a decision anyone made. The alternative — a small letterspaced
Silkscreen `SEND`, consistent with the old command-bar button — is a two-line
swap in `.composer-send` and the `setDetailComposerRunning` glyph.

### Original diagnosis (kept for context)

The footer stacked **three rows** in a 360px drawer and totalled 128px of
vertical space. Measured at the default width:

| Element | Size | Border | Background |
|---|---|---|---|
| model select | 131 × 30 | 1px solid | `--surface` |
| permission select | 140 × 30 | 1px solid | `--surface` |
| `@` button | 20 × 21 | **none** | **transparent** |
| `MCP` button | 35 × 21 | **none** | **transparent** |

Three concrete defects fall out of those numbers:

1. **The icon group is forced to wrap.** 131 + 140 + 6px gap = 277px, leaving
   52px of the 329px inner width — but the `@`/`MCP` group needs 61px. It
   can never fit, at any drawer width below ~415px. The existing
   `.drawer-footer-icon-group` rule keeps the two buttons *together* when they
   wrap, which was the right call, but the wrap itself is the problem.

2. **The controls aren't one visual family.** 30px tall vs 21px, bordered vs
   borderless, `--surface` vs transparent, and `--text-faint` on the buttons
   versus the darker `--text-muted` on the selects. The `@` and `MCP` buttons
   are *lighter* than the already-muted selects, so they read as disabled
   text rather than controls. A bare `@` glyph with no border reads as a
   stray character.

3. **The selects still render native OS chrome** — computed `appearance: auto`
   — which is where the grey caret box comes from. Every other control in the
   app is flat.

There's also an information-architecture error underneath the styling: **`@`
and `MCP` are not the same kind of control.** `@` is a composer action that
inserts text into the input. `MCP` is per-project server *status* that has
nothing to do with the message being written. They were grouped because both
happened to be small leftover buttons, which is why the pairing looks
arbitrary.

### Agreed design — unified composer

An earlier proposal gave `@` and `MCP` borders to match the selects. It was
rejected, correctly: matching five bordered objects to each other is more
consistent but *less* minimal. The accepted direction inverts it — **take the
borders off the selects and let one container carry the whole footer.**

```
┌──────────────────────────────────────────────┐
│  Send an instruction to this agent…          │
│                                              │
│  @  /  opus ▾  ask ▾  ● 3       $0.42   (↑)  │
└──────────────────────────────────────────────┘
```

- **One border for the footer, not five.** The container holds a text area on
  top and a control rail beneath it.
- **Controls are ghost buttons** — no border, no background, revealing a soft
  background only on hover. This keeps the affordance the current `@`/`MCP`
  lack while removing the chrome.
- **Labels in lowercase mono**, matching the terminal aesthetic the rest of
  the app already runs on (dot grid, Silkscreen eyebrows, JetBrains Mono).
- **The text area grows with content**, which is what makes this layout also
  the fix for the multi-line composer in section 2. Do not build these
  separately — the container only makes sense around a growing input, and
  splitting them means writing the layout twice.
- **`MCP` becomes a live status chip** (dot + server count) rather than a bare
  text button, so it reports something without being clicked. It still opens
  the existing `#mcp-panel`.
- Selects get `appearance: none` and a custom caret. The ellipsis rule for
  long `Default (…)` labels stays as the safety net.

Apply the same treatment to the **main command bar** in the same pass — it has
the identical five-competing-boxes problem, and it's where the longest prompts
get written. Fixing only the drawer leaves the two composers visibly drifted.

Do this on top of the `<div>` → `<button>` conversion from section 4: the
`.drawer-ctl` UA-chrome reset exists only to paper over that mismatch and can
then be deleted rather than extended.

### Rail states

| State | Rail contents | Send control |
|---|---|---|
| idle | `@` `/` `opus ▾` `ask ▾` `● 3` · cost | accent disc `↑` |
| running | `@` `/` `● working` · cost | outlined stop square |
| queued | `queued · sends when idle ×` | outlined stop square |

The `working` dot got a home where the user is actually looking; the old
`#chat-working` strip above the footer was easy to miss and is now deleted.
The `queued` row is still to build — see item 2 below.

### Composer features still to build

Both need server work.

1. **Paste a screenshot.** There is currently no paste, clipboard, or image
   handling anywhere in the codebase. For a dashboard this is the highest-value
   new capability — see a broken card, screenshot it, paste it into the prompt.
   Fits the existing architecture: on paste, POST the blob, server writes a
   temp file, insert the path into the input exactly as `@` already does. It
   reuses the file-path mechanism end to end rather than adding a new one.

2. **Queue instead of block.** Type a follow-up while the agent works; it
   sends itself when the session flips idle. Today the composer refuses the
   send with a toast, which is honest but a dead end. **Open decision:**
   client-side is a few lines (the WebSocket already reports idle) but a
   queued message dies with the tab; server-side survives that but is real
   work. Start client-side, move it only if messages actually get lost.

3. **Per-session cost, ambient.** Unrevert `285da7d` — the store and route are
   already written. A muted `$0.42` in the rail, not a panel to open. The rail
   already has the space reserved for it.

### Remaining build order

1. Paste screenshots
2. Queue, then cost

---

## 7. Housekeeping

- **Three scratch transcripts left on disk from verification.** Created
  2026-07-27 to test the composer's in-flight states, under
  `~/.claude/projects/C--Users-...-scratchpad-djinn-verify/` (ids `0e59c994`,
  `5720cb78`, `ce5858b9`). They were invisible until the section 5 item 4 fix
  and are now *visible in the dashboard*, so they read as real sessions. The
  path is also in the tracked-projects list and in recent directories. Safe to
  delete all three plus the folder; nothing references them.

- **Branch not merged.** `composer-redesign` is 4 commits ahead of `master`
  and there is still no remote anywhere, so every commit in this repo exists
  on exactly one disk.
