# Interactive Session Mode — Design Spec

Date: 2026-09-06
Status: approved, pending implementation plan

## Context

`fraude-code` currently only supports one-shot invocation:
`fraude -p "<prompt>"` runs a single prompt through the agent loop and
exits. See [[../background|docs/background.md]] and
[[../requirements#interactive-session-mode|docs/requirements.md]] for the
originally logged requirement, and [[../design#open-questions|docs/design.md]]
for the open questions this spec resolves.

This spec resolves those open questions and replaces one-shot mode with an
interactive, persistent, multi-session TUI, built with Ink.

## Decisions (resolved open questions)

| Question | Decision |
|---|---|
| readline vs. TUI library | **Ink** (React-based) |
| Keep `-p` alongside interactive mode? | **No** — `-p` is removed entirely |
| Session persistence across launches | **Yes**, persisted to disk |
| Single ongoing session vs. multiple named sessions | **Multiple named sessions** |

## CLI surface

```
fraude [session-name]
```

- `session-name` is an optional positional argument.
- Defaults to `"default"` when omitted.
- No flags. `-p` and the old `flag !== "-p"` validation are deleted.

## Module breakdown

Splitting `app/main.ts` into focused modules so the file doesn't become a
monolith mixing rendering, persistence, and agent logic:

- **`app/tools.ts`** — relocated, unchanged logic:
  - `TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[]`
  - `getFunctionToolCalls(message)`
  - `executeToolCall(toolCall)`
  - `runCommand(command)`
- **`app/agent.ts`** — the agent loop, extracted from `main()`'s
  `while (true)` block into a reusable function:
  ```ts
  export type ToolCallEvent =
    | { phase: "start"; name: string; args: unknown }
    | { phase: "end"; name: string; result: string };

  export async function runAgentTurn(
    client: OpenAI,
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    onToolCall?: (event: ToolCallEvent) => void
  ): Promise<string> // returns the final assistant text, mutates `messages` in place
  ```
  Internally this is the same loop as today (call API → push assistant
  message → if no tool calls, return the content → else execute each
  tool call via `executeToolCall`, firing `onToolCall` before/after each,
  push `{role: "tool", ...}` messages, loop). `messages` is mutated (via
  `.push`) rather than returned, matching the existing array-mutation
  style in the current code and letting the caller own persistence
  timing.
- **`app/session-store.ts`**:
  ```ts
  export function loadSession(name: string): OpenAI.Chat.Completions.ChatCompletionMessageParam[]
  export function saveSession(name: string, messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): void
  ```
  - Storage location: `~/.fraude/sessions/<name>.json`.
  - File contents: the `messages` array, JSON-serialized directly (it's
    already plain, serializable data — no wrapper envelope needed).
  - `loadSession` creates `~/.fraude/sessions/` if missing and returns
    `[]` if the named session file doesn't exist yet.
  - `saveSession` is called after every completed turn (i.e. after
    `runAgentTurn` returns), so a crash mid-turn loses at most the
    in-progress turn, never prior history.
  - Session names are used directly as filenames; since they come from
    `process.argv` (a single positional arg, not free text from the
    model), no additional sanitization beyond what the filesystem itself
    rejects is needed for this personal-use tool.
- **`app/ui/App.tsx`** — the Ink component tree (below).
- **`app/main.ts`** — thin entry point: parse `argv[2]` as the session
  name (default `"default"`), fail fast on missing `OPENROUTER_API_KEY`
  (plain `console.error` + `process.exit(1)`, before Ink renders), then
  `render(<App sessionName={...} client={...} initialMessages={...} />)`.

## Ink UI (`app/ui/App.tsx`)

Uses Ink's `<Static>` for anything finalized and never re-rendered, plus a
dynamic footer for the live input/status line — the standard Ink pattern
for chat-style CLIs.

**Static region** (rendered once each, appended over time):
1. Landing banner — project name/branding, current session name, a short
   usage hint (e.g. "Type a message and press Enter. Ctrl+C to exit.").
   Rendered once at startup.
2. One entry per completed turn: the user's message, any tool-call lines
   (e.g. `→ Read({"file_path":"README.md"})`), and the assistant's final
   text — each pushed to the static list as it completes.

**Dynamic footer** (re-renders on state change):
- A text input using `<TextInput>` from the `ink-text-input` package for
  composing the next message (avoids hand-rolling cursor/backspace
  handling via raw `useInput`).
- While a turn is in flight: input is replaced by a status line showing
  a spinner and, when available, which tool is currently running (driven
  by the `onToolCall` callback from `runAgentTurn`).

**State shape** (component-local, in `App.tsx`):
```ts
type StaticEntry = { type: "banner" } | { type: "user"; text: string }
  | { type: "tool"; name: string; args: unknown; result?: string }
  | { type: "assistant"; text: string } | { type: "error"; text: string };

const [entries, setEntries] = useState<StaticEntry[]>([{ type: "banner" }]);
// Mutated in place by runAgentTurn (via .push) and read for both the next API
// call and saveSession. A ref, not state - its identity/mutation should never
// itself trigger a re-render; entries/status above are what drive rendering.
const messagesRef = useRef([...initialMessages]);
const [status, setStatus] = useState<"idle" | "thinking" | { tool: string }>("idle");
```

## Error handling

- Missing `OPENROUTER_API_KEY`: fails before Ink renders — same
  `console.error` + throw/exit behavior as today's `main()`.
- A failed `client.chat.completions.create` call (network error, API
  error) during a turn: caught in the submit handler, appended to
  `entries` as an `{ type: "error" }` line, status returns to `"idle"`,
  the failed turn is **not** persisted via `saveSession` (only completed
  turns are saved), and the input is available again for retry.
- Ctrl+C / Ctrl+D exits the process normally; since `saveSession` already
  ran after the last completed turn, there's nothing additional to flush
  on exit.

## Non-goals (explicitly out of scope for this spec)

- No session-listing/picker UI (`ls ~/.fraude/sessions` covers it for now).
- No session deletion/rename commands.
- No change to tool sandboxing (`Bash` remains unsandboxed — tracked
  separately in [[../design#open-questions|docs/design.md]]).
- No change to sync vs. async tool execution (also tracked separately).
- No automated test suite — manual verification only (see Testing below).

## Testing (manual)

1. `fraude` with no args → lands on `"default"` session, shows banner,
   accepts a message, gets a response.
2. `fraude work` → creates/loads `~/.fraude/sessions/work.json`,
   independent from `default`.
3. Send a message that triggers a tool call (e.g. "read README.md") →
   confirm the tool-call line appears in the transcript and the file is
   actually read.
4. Exit (Ctrl+C) and relaunch `fraude work` → prior conversation history
   is present and the model has context from it.
5. Trigger an API error (e.g. temporarily bad API key) → confirm an
   error line appears and the session isn't corrupted/left mid-write.

## New dependencies

- `ink`
- `react`
- `ink-text-input`

`tsconfig.json` already has `"jsx": "react-jsx"` set — no config changes
needed for JSX/Ink support.
