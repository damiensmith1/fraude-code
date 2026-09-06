# fraude-code

A for-fun project where I'm building my own miniature version of Claude
Code from scratch, mostly to understand what's actually happening under
the hood of an LLM coding agent: the request loop, tool calling, and how
the model reads/writes files and runs shell commands to get things done.

No frameworks, no agent SDKs — just an OpenAI-compatible chat completions
call, a small set of hand-written tools, and a loop that keeps feeding
tool results back to the model until it's done.

## How it works

`app/main.ts` opens an interactive session through an agent loop:

1. Send the conversation so far to the model (via [OpenRouter](https://openrouter.ai),
   currently routed to `anthropic/claude-haiku-4.5`), along with the tools
   it's allowed to call.
2. If the model responds with tool calls, run each one locally and append
   the results back into the conversation as `tool` messages.
3. Once the model responds with a plain answer, print it and wait for
   your next message — repeating until you exit the session.

### Tools implemented so far

- **Read** — read a file's contents.
- **Write** — write content to a file.
- **Bash** — execute a shell command and capture stdout/stderr.

The `Bash` tool runs whatever command the model gives it with no
sandboxing or confirmation step — fine for poking at this locally, but
not something to point at untrusted prompts.

## Setup

1. Install [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`).
2. Install dependencies: `bun install`.
3. Copy `.env.example` to `.env` and fill in your own key:
   ```sh
   cp .env.example .env
   ```
   - `OPENROUTER_API_KEY` — your [OpenRouter](https://openrouter.ai/keys) API key.
   - `OPENROUTER_BASE_URL` — optional, defaults to `https://openrouter.ai/api/v1`.

## Usage

```sh
./fraude-code.sh [session-name]
```

Or, using the global `fraude` command (see below): `fraude [session-name]`.

`session-name` is optional and defaults to `"default"`. Each session's
conversation history is saved to `~/.fraude/sessions/<session-name>.json`
and resumed automatically the next time you open that same session name.
