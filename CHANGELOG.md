# Changelog

## 0.0.4-beta

- Privacy: a path to a secret file (`.env`, keys) or a command naming one is sent only as `[secret file]`; a password written in words ("my password is …") is redacted; events queued for a repo you switched off are never sent.
- `arcroom sent` shows what this laptop sent (kept 7 days in `~/.arcroom/sent`).
- Windows: one hook launch per tool call instead of two, no status line unless `--status`, every child process hidden.
- Done-checks count PowerShell runs, are read from the repo root and approved once per repo.
- `init` checks the key with the API and names the workspace; a key for another workspace becomes that repo's own key; `init --everywhere` covers every clone and worktree of the repos you set up; files it writes stay out of git.
- Hand-overs: a similar task needs more than meaning alone and the line shows how it matched; the last-run note is your own run on this branch, with repo paths, the last ask, a failing check and unfinished sessions.
- Two agents on one file: the first edit waits once and says who is on it.
- The loop guard lets a status check repeat with a wait between; saves made while offline are sent later; a refused key says so once.
- File hashes match across Windows and Mac line ends.
- `arcroom uninstall [--all]`.
- Team facts and decisions come newest first, each with its date; `arcroom wrong` with no id lists every memory the last hand-over gave, to name the wrong one.
- Codex sessions report their token usage.
- An MCP client with no ArcRoom hooks is told to save its work with the tools, not that it is recorded automatically; tool calls inside a subagent say which subagent ran them.
- CI: `ARCROOM_APPROVE_CHECKS=<code>` in the job's environment approves the done-checks; `arcroom flush` sends what is queued before the job ends.
- Big repos: a moved file is found through git's index (no 2,000-file limit), a moved-and-edited one by its name, and the background tree sync gets 30 s.

## 0.0.3-beta

- Windows: no more terminal windows flashing open on every agent step. Every program ArcRoom starts (git, the OpenCode bridge, `claude mcp add`) now starts hidden.

## 0.0.2-beta

- `init` asks for a new key when the saved one was refused, instead of reusing it.
- `init` moves a saved local API URL to the live API and says so (`--url` keeps a local one).
- Commands that can't reach the API print one line, not a stack trace.

## 0.0.1-beta

First public beta: `init` for Claude Code, Codex, Cursor and OpenCode (experimental), hand-overs on every prompt, loop guard, done-checks, `doctor`, `off` / `on`, `wrong`, `rule`, `code`.
