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

## What leaves your laptop

Prompts (system reminders removed, secrets redacted, first 1,000 characters), file paths, search patterns, shell commands (first 1,000 characters), URLs and web queries, done-check results, git hashes of the files a turn touched, token counts, and what an agent saves on purpose with ArcRoom's tools. **Never file contents, tool output or edit diffs.** A path to a secret file (`.env`, keys), or a command that names one, leaves only as `[secret file]`.

Every event passes through `~/.arcroom/spool.jsonl` on its way out and is sent within seconds; what was sent is kept for 7 days in `~/.arcroom/sent/`, and `arcroom sent` shows it. `arcroom off` stops ArcRoom for one repo on this laptop, including anything still queued for it; `arcroom on` starts it again.

## If the API is down

Hooks never block a session. Memory lookup gives up after 3 seconds, the prompt goes through without it ("memory offline"), and lookups pause for a minute.

## Commands

| Command | What it does |
| --- | --- |
| `arcroom init [--agent claude\|codex\|cursor\|opencode] [--project <id>]` | set up this machine and project |
| `arcroom whoami` | who the key belongs to |
| `arcroom doctor` | checks the key, the API, the hooks in this folder and the uploader, and prints the fix for each problem |
| `arcroom off` / `arcroom on` | stop or restart ArcRoom for this repo |
| `arcroom flush` | waits until everything queued was sent: the last step of a CI job (exits 1 if it could not) |
| `arcroom sent [YYYY-MM-DD] [--all]` | what this laptop sent that day (kept 7 days), exactly as sent with `--all` |
| `arcroom init --everywhere` | also cover every other clone and worktree of the repos you set up (Claude Code user settings) |
| `arcroom uninstall [--all]` | take ArcRoom out of this project for every agent; `--all` also deletes `~/.arcroom` |
| `arcroom checks` / `arcroom checks approve <code>` | read and approve the done-checks in `.arcroom.json` (in CI, where there is no terminal: set `ARCROOM_APPROVE_CHECKS=<code>` in the job's environment) |
| `arcroom wrong [memo id] [reason]` | report a memory that was wrong |
| `arcroom decide "<choice>" --why ...` | record a team decision |
| `arcroom rule [--tag t] [--max-hits n] [--idle-days d]` | team rules for when memory expires |
| `arcroom code [status\|sync\|on\|off]` | the code map |

Docs: https://www.arcroomai.com/docs
