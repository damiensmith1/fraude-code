---
title: Fraude Code — Design
tags:
  - project
  - fraude-code
status: active
---

# Design

See [[requirements]] for what this needs to do, [[background]] for why.

## Architecture

`app/main.ts` is a thin entry point: it parses an optional session-name
positional argument (defaulting to `"default"`), fails fast if
`OPENROUTER_API_KEY` is missing, loads that session's history, and
renders the Ink app. The actual logic lives in four focused modules:

- `app/tools.ts` — `TOOLS`, a module-level array of OpenAI
  `ChatCompletionTool` schemas (`Read`, `Write`, `Bash`);
  `getFunctionToolCalls(message)`, which validates each tool call is a
  well-formed `"function"`-type call before returning it;
  `executeToolCall(toolCall)`, which parses the JSON `arguments` string
  and dispatches on `name` via a `switch`; and `runCommand(command)`,
  which wraps `execSync` for the `Bash` tool, returning combined
  `stdout`/`stderr` on failure so the model sees what went wrong.
- `app/agent.ts` — `runAgentTurn(client, messages, onToolCall?)`: the
  agent loop, extracted so it can run once per user turn instead of
  once per process. Calls the model, pushes its response onto
  `messages`, and if there are no tool calls, returns the final text.
  Otherwise it executes each tool call (firing `onToolCall` with
  `{phase: "start", ...}` before and `{phase: "end", ...}` after, so a
  UI can show live progress), pushes a `{role: "tool", ...}` message per
  call, and loops back to another API call.
- `app/session-store.ts` — `loadSession(name)` / `saveSession(name,
  messages)`, persisting a session's `messages` array as JSON at
  `~/.fraude/sessions/<name>.json`.
- `app/ui/App.tsx` — the Ink component: a `<Static>` region for the
  landing banner and the finalized transcript (user messages, tool-call
  lines, assistant replies, errors — each appended once and never
  re-rendered), plus a dynamic footer that's either a text input or a
  thinking/tool-status line depending on whether a turn is in flight.
  On submit, it calls `runAgentTurn` and, on success, `saveSession` —
  a failed turn shows an inline error instead and is never persisted.

## CLI distribution

`fraude-code.sh` resolves its own real location by walking up through
symlinks (the standard `BASH_SOURCE` + `readlink` loop), so it works
correctly whether it's run directly (`./fraude-code.sh`) or via the
`fraude` symlink in `~/.bun/bin` from any working directory. It then runs:

```sh
bun run --env-file="$DIR/.env" "$DIR/app/main.ts" "$@"
```

`--env-file` is explicit rather than relying on Bun's automatic `.env`
loading, because automatic loading only looks at the *caller's* current
directory — which breaks once `fraude` is invoked from somewhere other
than the repo root.

## Git history

The repo was originally scaffolded from a CodeCrafters challenge template
(see [[background]]). Before publishing, the CodeCrafters plumbing was
removed and the git history was squashed into a single fresh commit, so
the public GitHub history has no CodeCrafters-authored commits or
challenge-submission messages in it.

## Open Questions {#open-questions}

1. **How should interactive session mode be implemented?**
   Options include a hand-rolled `readline` loop vs. a TUI library (e.g.
   Ink, blessed). A hand-rolled loop probably fits the project's ethos
   better (understanding internals, no frameworks), but isn't decided.
   **Resolved** (2026-09-06): see
   [[superpowers/specs/2026-09-06-interactive-session-design|the design spec]].
2. **Does session state persist across separate `fraude` invocations**,
   or is each session's `messages` array purely in-memory and gone when
   the process exits (as it is today, once per one-shot call)?
   **Resolved** (2026-09-06): see
   [[superpowers/specs/2026-09-06-interactive-session-design|the design spec]].
3. **Does the existing `-p "<prompt>"` one-shot mode stay** alongside a
   new interactive mode, or does interactive mode replace it entirely?
   **Resolved** (2026-09-06): see
   [[superpowers/specs/2026-09-06-interactive-session-design|the design spec]].
4. **Is OpenRouter (`openai` SDK, `anthropic/claude-haiku-4.5`) a
   long-term choice**, or should this move to the native
   `@anthropic-ai/sdk` (already tried once and reverted — see
   [[background]]) or support multiple providers?
5. **Should tool execution move off synchronous calls**
   (`readFileSync`/`writeFileSync`/`execSync`) to their async
   equivalents? Currently sync keeps the loop trivial to read start to
   finish; that trade-off is worth revisiting if interactive mode needs
   cancellable or concurrent tool calls. See [[Async Vs Sync]] for the
   general trade-offs.
6. **Should the `Bash` tool gain any safety gate** — confirmation prompt,
   allowlist, or similar? Explicitly *not* done yet (see
   [[requirements#non-goals-tentative--not-yet-explicitly-confirmed-with-the-user|Requirements → Non-goals]]),
   flagged repeatedly during development as a real risk accepted for
   personal local use only.
