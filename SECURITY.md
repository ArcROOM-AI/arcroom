# Security

Report a problem privately to **sachin.kumar@arcroomai.com**. Please don't open a public issue for it.

## What leaves your laptop

Prompts (system reminders removed, secrets redacted, first 1,000 characters), file paths, search patterns, shell commands (first 1,000 characters), URLs and web queries, done-check results, git hashes of the files a turn touched, token counts, and what an agent saves on purpose with ArcRoom's tools.

**Never file contents, tool output or edit diffs.** A path to a secret file (`.env`, keys), or a command that names one, leaves only as `[secret file]`. Every event passes through `~/.arcroom/spool.jsonl` on its way out and is sent within seconds, and is kept for 7 days in `~/.arcroom/sent/` so you can check it (`arcroom sent`); `arcroom off` stops a repo, including anything still queued for it. Redaction is in [`src/redact.ts`](src/redact.ts).
