---
title: Fraude Code — Design
tags:
  - project
  - fraude-code
status: active
---

# Design

See [[requirements]] for what this needs to do, [[background]] for why.

## Architecture (current, one-shot mode)

Everything lives in a single entrypoint, `app/main.ts`:

- `TOOLS` — a module-level array of OpenAI `ChatCompletionTool` schemas
  (`Read`, `Write`, `Bash`), passed to every chat completions request.
- `main()` — seeds a `messages` array with the user's prompt, then runs
  the agent loop:
  1. Call the model with the full `messages` history plus `TOOLS`.
  2. Push the assistant's response message onto `messages`.
  3. If it has no tool calls, print `message.content` and exit.
  4. Otherwise, execute each tool call and push a
     `{ role: "tool", tool_call_id, content }` message per call, then
     loop back to step 1.
- `getFunctionToolCalls(message)` — pulls `message.tool_calls` and
  validates each one is actually a `"function"`-type call with string
  `name`/`arguments`, throwing on anything malformed rather than
  silently misreading it.
- `executeToolCall(toolCall)` — parses the JSON `arguments` string and
  dispatches on `name` via a `switch`, so adding a new tool is one new
  `case`.
- `runCommand(command)` — wraps `execSync` for the `Bash` tool; on
  failure, pulls `stdout`/`stderr` off the caught error and returns their
  concatenation so the model sees what actually went wrong.

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
   (See [[requirements#interactive-session-mode|Requirements → Interactive Session Mode]].)
   Options include a hand-rolled `readline` loop vs. a TUI library (e.g.
   Ink, blessed). A hand-rolled loop probably fits the project's ethos
   better (understanding internals, no frameworks), but isn't decided.
2. **Does session state persist across separate `fraude` invocations**,
   or is each session's `messages` array purely in-memory and gone when
   the process exits (as it is today, once per one-shot call)?
3. **Does the existing `-p "<prompt>"` one-shot mode stay** alongside a
   new interactive mode, or does interactive mode replace it entirely?
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
