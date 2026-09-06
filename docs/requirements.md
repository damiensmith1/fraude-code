---
title: Fraude Code — Requirements
tags:
  - project
  - fraude-code
status: active
---

# Requirements

See [[background]] for why this project exists.

## Functional requirements (shipped)

- CLI accepts an optional `session-name` positional argument
  (`fraude [session-name]`, defaulting to `"default"`) and opens an
  interactive session instead of running one shot.
- The model is given a set of tools via OpenAI-compatible function/tool
  calling on the chat completions endpoint.
- Tool execution:
  - **Read** — read and return a file's contents.
  - **Write** — write content to a file.
  - **Bash** — execute a shell command, capturing stdout and stderr.
- Agent loop: keep sending the conversation (including prior tool results)
  back to the model until it responds with no tool calls, then print only
  that final message to stdout. Tool results themselves are never printed
  directly — only fed back into the conversation.
- Global `fraude` command: usable from any working directory, always
  loading credentials from the repo's own `.env` regardless of the
  caller's current directory.
- Interactive session mode: `fraude [session-name]` opens a persistent,
  interactive session with a landing banner. Conversation history is saved
  to disk and resumes automatically across separate invocations.

## Non-functional requirements / constraints

- Stay minimal and hand-rolled — no agent SDKs or frameworks. The value of
  the project is understanding the internals, so implementation should
  stay simple enough to read start to finish.
- Runs on [Bun](https://bun.sh).

## Non-goals (tentative — not yet explicitly confirmed with the user)

- **No sandboxing for the `Bash` tool.** It executes whatever command the
  model gives it, with no allowlist or confirmation step. This has been
  flagged repeatedly during development and is being knowingly accepted
  for now, since this is a personal tool run locally against prompts the
  user controls — not something to point at untrusted input.
- Not currently aiming for production use or multi-user support.
- Not currently aiming for multi-provider support (see
  [[design#open-questions|Design → Open Questions]] on whether OpenRouter
  vs. a native Anthropic SDK is a long-term choice).

These non-goals haven't been explicitly confirmed — flag it if any of them
is wrong.
