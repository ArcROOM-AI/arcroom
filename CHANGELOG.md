# Changelog

## 0.0.3-beta

- Windows: no more terminal windows flashing open on every agent step. Every program ArcRoom starts (git, the OpenCode bridge, `claude mcp add`) now starts hidden.

## 0.0.2-beta

- `init` asks for a new key when the saved one was refused, instead of reusing it.
- `init` moves a saved local API URL to the live API and says so (`--url` keeps a local one).
- Commands that can't reach the API print one line, not a stack trace.

## 0.0.1-beta

First public beta: `init` for Claude Code, Codex, Cursor and OpenCode (experimental), hand-overs on every prompt, loop guard, done-checks, `doctor`, `off` / `on`, `wrong`, `rule`, `code`.
