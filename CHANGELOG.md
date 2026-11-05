# Changelog

## 0.0.8-beta

- After a long chat is compacted, the agent gets its own first ask, latest ask and edited files back, and the team facts and code map come again with the next prompt.
- `arcroom handed` shows what the agent was given at session start and before each prompt, and what was left out for room (titles and sizes, kept 7 days on this laptop).
- Open now from teammates: a new session sees the sessions teammates have open in the same repo and the tasks they claimed but did not finish. If the first prompt matches one (the same file, or most of the same words), the agent is told to check with them first. `arcroom open off` turns it off for a repo.
- Session start sends its blocks in one piece, so the last-run note can no longer be dropped by another block.
- `arcroom why <file>` shows the team's decisions and facts about a file: what was chosen, why, and what was dropped and why.
- A decision or fact whose files changed since it was saved is handed over with a "may be stale" line.
- `arcroom import` turns the rules you already wrote (`CLAUDE.local.md`, your memory notes, Cursor rules; `--all` adds CLAUDE.md and AGENTS.md) into team facts, once, after you see the list and say yes. Hooks still never read these files, and nothing ever writes them.

## 0.0.7-beta

- Install ArcRoom as a Claude Code plugin: `/plugin marketplace add ArcROOM-AI/arcroom`, then `/plugin install arcroom@arcroom`. It is on in every project with nothing written into them, and steps aside where `arcroom init` already set a project up.
- `arcroom login` saves and checks the key without touching the project. Until there is a key, the plugin records nothing and says so once when a session starts.

## 0.0.6-beta

- Hand-overs carry the whole ask (up to 1,000 characters), not its first 200, so a session stopped mid-job no longer loses the steps that were left to do. A session that never closed no longer shows a wrong "0 tool calls".
- Saving an answer that depends on a folder (`feedback/`) no longer freezes the session: the folder counts as the files in it, and every error ArcRoom's tools return is one Claude Code can read.

## 0.0.5-beta

- Team facts and decisions belong to the repo they were saved in, so they are handed out there and not in every repo.
- Each line in ArcRoom team knowledge starts with its memo id, so an agent can say what a new fact or decision replaces; a fact can now replace a fact.
- A save that ArcRoom refuses (the same words were replaced or reported wrong before) says why and is not retried.
- `arcroom wrong` says what happened in plain words (steps broken, which older steps take over, answer thrown away) and names a playbook by its title.
- ArcRoom never reads or writes CLAUDE.md or AGENTS.md, and a test proves it.
- Blind mode is removed. A repo whose `.arcroom.json` says `"code": "blind"` now syncs in standard mode.

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
