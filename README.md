# Djinn

Djinn is a local web dashboard for the `claude` CLI (Claude Code). It gives you one screen for every Claude Code session across all your projects: live status and last activity for each session, a chat view for any of them, the ability to start a new session in any directory, a repo-tagged backlog, and editable shared and per-project memory. On first run you name your own assistant, and that name is used throughout the UI.

The `claude` CLI remains the engine — Djinn reads its transcripts and spawns it for you; it does not replace it.

## Requirements

- Node.js 18 or newer
- The [`claude` CLI](https://docs.anthropic.com/en/docs/claude-code) installed and logged in

## Install & run

```bash
npm install
npm start
```

Then open http://127.0.0.1:4317 in a browser.

## How it works

- Reads session transcripts from `~/.claude/projects` to build the session list, statuses, and chat history.
- Reads `~/.claude.json` (Claude Code's own project registry) strictly read-only, to resolve encoded folder names back to real project paths. Djinn never writes to it.
- Spawns the `claude` CLI to start new sessions and to send follow-up instructions to existing ones.
- Stores its own state — backlog, memory, settings, recent directories — in a local `data/` directory, which is gitignored.

## First run

On first launch you'll be asked to name your assistant and pick which projects to track. Untracked projects are only hidden from the dashboard — nothing on disk changes, and you can change the selection at any time.

## Security

The server binds to `127.0.0.1` only and has no authentication. Its API can spawn processes in arbitrary directories, so do not expose it to a network (no port forwarding, no reverse proxy, no `0.0.0.0`).

## Known limitations

- Running status is only tracked for sessions Djinn itself spawned. Sessions started in a terminal show their history but never light up as running — there is no reliable on-disk "is running" flag to read.

## Development

- `npm test` runs the test suite via `node --test`.
- Architecture in one line: a dependency-injected Express + WebSocket server (`server/`) over small single-responsibility stores (`server/lib/`), with a no-build vanilla JS frontend (`public/`). See `CLAUDE.md` for conventions and domain gotchas.
