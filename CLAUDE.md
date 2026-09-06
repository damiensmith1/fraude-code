# fraude-code

A personal, for-fun clone of Claude Code: a hand-rolled TypeScript agent
loop (no agent frameworks/SDKs) that talks to an LLM via OpenAI-compatible
tool calling, running on Bun. See `docs/` for the full picture.

- `docs/background.md` — what this is, why it exists, where it came from
- `docs/requirements.md` — what it needs to do, non-goals
- `docs/design.md` — architecture, CLI distribution, open questions

## Conventions

- Entry point: `app/main.ts`. No frameworks — keep the implementation
  simple enough to read start to finish.
- Run locally: `./fraude-code.sh -p "<prompt>"`, or `fraude -p "<prompt>"`
  from anywhere (global command symlinked into `~/.bun/bin`).
- Package manager / runtime: Bun (`bun install`, `bun run`).
- Credentials live in `.env` (gitignored) — see `.env.example`.

## Keeping docs in sync

Everything under docs/ is this project's source of truth, not a one-time
snapshot — including any file added there after initial setup, not just
background.md/requirements.md/design.md. In the SAME turn as a code
change (not a followup), update the relevant doc when you:
- resolve or add an open question in design.md
- make or change an architecture/approach decision
- add, change, or drop a requirement or non-goal
- learn something that changes the "why" in background.md
- create a new doc under docs/ for a topic that doesn't fit the above

Don't fabricate a decision that wasn't actually made. If it's unclear
whether something is doc-worthy, ask instead of guessing.
