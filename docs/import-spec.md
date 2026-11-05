# `arcroom import`: spec

One command, run once per repo by a person, that turns the rules a team already wrote down into team facts and
decisions, so a new team's first session is not empty. Nothing is sent until the person has seen the list and said yes.

## Decision: option B (5 Nov)

Built as **B** below. Since 0.0.5 the plugin promised, and `init.test.ts` enforces, that **no plugin code reads or writes CLAUDE.md or
AGENTS.md**: "they hold the team's rules and stay their only owner". Import reads them, so the promise changes. Three
ways to go:

| | What import reads | The promise becomes | Trade-off |
| --- | --- | --- | --- |
| **A** | everything below | "Hooks never read or write them. `arcroom import`, run by you, reads them once and never writes them." | Simplest story. But Claude Code already loads a committed CLAUDE.md every session, so those lines are handed over twice. |
| **B** (recommended) | only what teammates' agents do not load already: `CLAUDE.local.md`, your Claude Code memory notes for this repo, Cursor rules, and AGENTS.md/CLAUDE.md only with `--all` | Same as A | No double hand-over for Claude Code teams; the real gain is notes that live on one laptop and rules another tool keeps. |
| **C** | nothing: park import | unchanged | Keeps the rule; a new team starts empty. |

The rest of this spec works for A and B. The test changes to: only `import.ts` may name these files, and no plugin
code writes them.

## Files read (from the repo root, never above it)

| Source | Read by default (B) | One item is |
| --- | --- | --- |
| `CLAUDE.local.md` | yes | a bullet |
| Claude Code memory notes for this repo (`~/.claude/projects/<this repo>/memory/*.md`, not `MEMORY.md`) | yes | a note: its `description` is the text, its body the why |
| `.cursor/rules/*.mdc`, `.cursorrules` | yes | a bullet (`.cursorrules`: a non-empty line) |
| `CLAUDE.md`, `.claude/CLAUDE.md`, `AGENTS.md` | with `--all` | a bullet |

Not read: anything outside the repo except the memory notes above, files over 200 KB, and symlinks that leave the repo.

## What becomes one item

- A **bullet** (`-`, `*`, `1.`) plus the indented lines under it. Paragraphs, headings, code blocks, tables and
  `<!-- BEGIN … END -->` blocks written by tools are skipped.
- **Always a fact.** Guessing "decision" from words misfires on rules ("never post there" read as a decision because
  it says "over one reply"); a person can turn a fact into a decision later with `arcroom decide … --replaces`.
- **Text:** the whole bullet, at most 500 characters (the API's limit). Only a longer one is split: the sentences that
  fit are the text, the rest (at most 500) the why. A memory note's `Why:` line is its why.
- **Files:** paths the item names that exist in the repo (at most 20), so it reaches the requests about them.
- **Source:** shown as `CLAUDE.local.md:12` (file and line, past any frontmatter) in the list and in `arcroom sent`.
- **Secrets:** every item goes through the same `redactText` as the recorder; an item that still looks like a key is dropped.
- **Duplicates:** the same words twice in one run are one item. Running import again adds nothing: `remember` refuses
  the same words.

## The steps

1. `arcroom import --dry-run`: finds the files, builds the numbered list, sends nothing, makes no network call.
2. `arcroom import`: shows the same list, then asks `Import these 23? (y / skip 3,5 / n)`. `n` or Ctrl+C sends nothing.
3. On yes: each item goes through `remember` (kind, text, why, files, project; a decision with its source), at most
   one request at a time. Each is listed in `arcroom sent`.
4. `arcroom off` in this repo: import refuses and says why.

## Example (B)

```
$ arcroom import
From CLAUDE.local.md, 2 memory notes, .cursor/rules/api.mdc: 6 items

  1. fact      Use pnpm, never npm.                                   CLAUDE.local.md:4
  2. fact      Sessions live in Postgres, not Redis.                  memory note "sessions-store"
               why: logout has to work on every API server
  ...
Import these 6? (y / skip 3,5 / n)
```

## Done when

A teammate can say for any sample line whether it becomes an item, and why. The hand-run on a real rules file
(T19) is in the PR notes, not in this public repo.
