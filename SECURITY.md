# Security

Report a problem privately to **security@arcroomai.com**. Please don't open a public issue for it.

## What leaves your laptop

Prompts (system reminders removed, secrets redacted, first 1,000 characters), file paths, search patterns, shell commands (first 1,000 characters), URLs and web queries, done-check results, git hashes of the files a turn touched, token counts, and what an agent saves on purpose with ArcRoom's tools.

**Never file contents, tool output or edit diffs.** Secret files (`.env`, keys) are skipped. Every upload waits first in `~/.arcroom/spool.jsonl`, so you can read it before it goes. Redaction is in [`src/redact.ts`](src/redact.ts).
