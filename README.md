# arcroom

One shared memory for every coding agent on your team. When Claude Code, Codex, Cursor or OpenCode finishes a piece of work, the next agent, on any teammate's laptop, is handed the steps instead of redoing it. ArcRoom also blocks an agent's third identical tool call in a row and keeps a run going while your done-checks fail.

## Quickstart

Sign up at [arcroomai.com](https://www.arcroomai.com), then get a key: **Settings → API keys** (shown once). Then, in the project you work on:

```
npx arcroom init        # paste the key when asked (or set ARCROOM_API_KEY)
npx arcroom whoami      # checks the key and the connection
```

Same memory for another agent in the same project:

```
npx arcroom init --agent codex     # or cursor, opencode (experimental)
```

`init` copies the plugin to `~/.arcroom/runtime` and adds its hooks and MCP server to the agent's settings. Nothing else needs to run.

Or, in Claude Code, install it as a plugin (on in every project, nothing written into them):

```
/plugin marketplace add ArcROOM-AI/arcroom
/plugin install arcroom@arcroom
```

then, once, in a terminal: `npx arcroom login` (paste the key). Where `init` already set up a project, the plugin steps aside there so nothing is recorded twice.

## What leaves your laptop

Prompts (system reminders removed, secrets redacted, first 1,000 characters), file paths, search patterns, shell commands (first 1,000 characters), URLs and web queries, done-check results, git hashes of the files a turn touched, token counts, and what an agent saves on purpose with ArcRoom's tools. **Never file contents, tool output or edit diffs.** A path to a secret file (`.env`, keys), or a command that names one, leaves only as `[secret file]`.

Every event passes through `~/.arcroom/spool.jsonl` on its way out and is sent within seconds; what was sent is kept for 7 days in `~/.arcroom/sent/`, and `arcroom sent` shows it. The other way round, `arcroom handed` shows what the next session was given and what was left out, by title and size (kept 7 days in `~/.arcroom/handed/`, never uploaded).

**What teammates see while you work.** When a teammate starts a session in the same repo, their agent gets a short list of the sessions open there and the tasks claimed but not finished: the name you signed up with (else your machine name; never your email), your latest ask (first 120 characters), the last 3 files you edited, whether you are working or waiting, and how long ago. If their first prompt matches your work (the same file, or most of the same words), it gets one line saying you are already on it. Every one of these comes from what `arcroom sent` already shows you. A session quiet for 30 minutes drops off the list; a claimed task shows for 2 days unless it is completed. `arcroom off` sends nothing, so new work in that repo is never listed; `arcroom open off` stops the list and the line for everyone in the repo (commit `.arcroom.json`). In OpenCode the list shows as a chat message; in Cursor the clash line comes with the first tool call. `arcroom off` stops ArcRoom for one repo on this laptop, including anything still queued for it; `arcroom on` starts it again.

## If the API is down

Hooks never block a session. Memory lookup gives up after 3 seconds, the prompt goes through without it ("memory offline"), and lookups pause for a minute.

## Commands

| Command | What it does |
| --- | --- |
| `arcroom init [--agent claude\|codex\|cursor\|opencode] [--project <id>]` | set up this machine and project |
| `arcroom login` | save and check the key only (for the Claude Code plugin) |
| `arcroom whoami` | who the key belongs to |
| `arcroom doctor` | checks the key, the API, the hooks in this folder and the uploader, and prints the fix for each problem |
| `arcroom off` / `arcroom on` | stop or restart ArcRoom for this repo |
| `arcroom flush` | waits until everything queued was sent: the last step of a CI job (exits 1 if it could not) |
| `arcroom sent [YYYY-MM-DD] [--all]` | what this laptop sent that day (kept 7 days), exactly as sent with `--all` |
| `arcroom import [--dry-run] [--all]` | once per repo: the rules you already wrote for agents (`CLAUDE.local.md`, your Claude Code memory notes for this repo, Cursor rules; `--all` adds CLAUDE.md and AGENTS.md) as team facts, after you see the list and say yes. It reads them and never writes them |
| `arcroom why <file>` | the team's decisions and facts that name this file: what was chosen, why, what was dropped and why, who and when |
| `arcroom open [on\|off]` | the "open now from teammates" list and the clash line at session start, for this repo (commit `.arcroom.json` to share it) |
| `arcroom handed [--last N]` | what the agent was handed at the last session start or prompt, and what was left out for room (kept 7 days) |
| `arcroom init --everywhere` | also cover every other clone and worktree of the repos you set up (Claude Code user settings) |
| `arcroom uninstall [--all]` | take ArcRoom out of this project for every agent; `--all` also deletes `~/.arcroom` |
| `arcroom checks` / `arcroom checks approve <code>` | read and approve the done-checks in `.arcroom.json` (in CI, where there is no terminal: set `ARCROOM_APPROVE_CHECKS=<code>` in the job's environment) |
| `arcroom wrong [memo id] [reason]` | report a memory that was wrong |
| `arcroom decide "<choice>" --why ...` | record a team decision |
| `arcroom rule [--tag t] [--max-hits n] [--idle-days d]` | team rules for when memory expires |
| `arcroom code [status\|sync\|on\|off]` | the code map |

Docs: https://www.arcroomai.com/docs
