# Interactive Session Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `fraude-code`'s one-shot `-p "<prompt>"` CLI with a persistent, multi-session Ink TUI: running `fraude [session-name]` opens a landing banner, then a turn-by-turn chat session whose history is saved to disk and resumed on the next launch of the same session name.

**Architecture:** Split the current monolithic `app/main.ts` into `app/tools.ts` (tool schemas + execution, unchanged logic), `app/agent.ts` (the agent loop, extracted into a reusable `runAgentTurn` function with a tool-call event callback), `app/session-store.ts` (JSON persistence under `~/.fraude/sessions/`), and `app/ui/App.tsx` (an Ink component using `<Static>` for the finalized transcript and a dynamic footer for input/status). `app/main.ts` becomes a thin entry point that parses the session name, loads history, and renders the app.

**Tech Stack:** Bun, TypeScript, `openai` npm SDK (OpenRouter), Ink, React, `ink-text-input`.

**Spec:** `docs/superpowers/specs/2026-09-06-interactive-session-design.md`

## Global Constraints

- CLI surface is exactly `fraude [session-name]` — one optional positional argument, no flags. `-p` is removed entirely.
- `session-name` defaults to `"default"` when omitted.
- Sessions persist as raw JSON message arrays at `~/.fraude/sessions/<name>.json`.
- Only fully completed turns are persisted via `saveSession` — a failed turn is never written.
- A failed API call during a turn shows an inline error entry in the transcript and returns the UI to an idle, retryable state — it must not crash the process.
- TUI is built with Ink: `<Static>` for anything finalized (never re-rendered), a dynamic footer for the live input box or a thinking/tool-status line.
- New dependencies: `ink`, `react`, `ink-text-input` (runtime) and `@types/react` (dev — required for TypeScript to type-check hooks/JSX; not spelled out in the spec but necessary for `tsc --noEmit` to pass).
- No automated test suite — every task is verified manually with concrete commands and expected output, per the spec's explicit non-goal.
- Out of scope for this plan (tracked separately in `docs/design.md`): `Bash` tool sandboxing, sync-vs-async tool execution, a session list/picker UI.
- **No TTY is available to any automated implementer, nor to the plan's controller** (confirmed by spiking Ink directly: `<TextInput>` — via `ink-text-input`'s internal `useInput` — throws "Raw mode is not supported" the instant it mounts without a real terminal, crashing the whole render before anything shows). Two mitigations apply everywhere in this plan: (1) every `<TextInput>` usage passes `focus={!!process.stdin.isTTY}`, a no-op in a real terminal that prevents the crash headlessly; (2) tasks verify what's achievable without real keystrokes (non-crashing render, `tsc --noEmit`, and for Task 5 specifically, `ink-testing-library`'s mock stdin — installed transiently with `bun add -d`, used, then removed with `bun remove` before that task's commit, since it is not a tracked project dependency). The one thing none of this proves — real interactive use in an actual terminal, including the global `fraude` command and session-resume UX — is deferred to a single human check after Task 6, not skipped.

---

### Task 1: Extract `app/tools.ts`

**Files:**
- Create: `app/tools.ts`
- Modify: `app/main.ts`

**Interfaces:**
- Produces: `TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[]`, `getFunctionToolCalls(message: OpenAI.Chat.Completions.ChatCompletionMessage): OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall[]`, `executeToolCall(toolCall: OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall): string`, `runCommand(command: string): string` — all exported from `app/tools.ts`.

- [ ] **Step 1: Create `app/tools.ts` with the tool schemas and execution logic, moved verbatim from `app/main.ts`**

```ts
import OpenAI from "openai";
import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";

export const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "Read",
      description: "Read and return the contents of a file",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "The path to the file to read",
          },
        },
        required: ["file_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Write",
      description: "Write content to a file",
      parameters: {
        type: "object",
        required: ["file_path", "content"],
        properties: {
          file_path: {
            type: "string",
            description: "The path of the file to write to",
          },
          content: {
            type: "string",
            description: "The content to write to the file",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Bash",
      description: "Execute a shell command",
      parameters: {
        type: "object",
        required: ["command"],
        properties: {
          command: {
            type: "string",
            description: "The command to execute",
          },
        },
      },
    },
  },
];

export function getFunctionToolCalls(
  message: OpenAI.Chat.Completions.ChatCompletionMessage
): OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall[] {
  const toolCalls = message.tool_calls;
  if (!toolCalls) {
    return [];
  }

  return toolCalls.map((toolCall) => {
    if (toolCall.type !== "function") {
      throw new Error(`unsupported tool call type: ${toolCall.type}`);
    }
    if (typeof toolCall.function?.name !== "string") {
      throw new Error("tool call is missing a function name");
    }
    if (typeof toolCall.function?.arguments !== "string") {
      throw new Error("tool call is missing function arguments");
    }
    return toolCall;
  });
}

export function executeToolCall(
  toolCall: OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall
): string {
  const { name, arguments: rawArgs } = toolCall.function;
  const args = JSON.parse(rawArgs);

  switch (name) {
    case "Read": {
      if (typeof args.file_path !== "string") {
        throw new Error("Read tool call is missing file_path");
      }
      return readFileSync(args.file_path, "utf-8");
    }
    case "Write": {
      if (typeof args.file_path !== "string") {
        throw new Error("Write tool call is missing file_path");
      }
      if (typeof args.content !== "string") {
        throw new Error("Write tool call is missing content");
      }
      writeFileSync(args.file_path, args.content, "utf-8");
      return `Wrote ${args.content.length} bytes to ${args.file_path}`;
    }
    case "Bash": {
      if (typeof args.command !== "string") {
        throw new Error("Bash tool call is missing command");
      }
      return runCommand(args.command);
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export function runCommand(command: string): string {
  try {
    return execSync(command, { encoding: "utf-8" });
  } catch (error) {
    const execError = error as {
      stdout?: string;
      stderr?: string;
      message: string;
    };
    const output = `${execError.stdout ?? ""}${execError.stderr ?? ""}`;
    return output || `Command failed: ${execError.message}`;
  }
}
```

- [ ] **Step 2: Update `app/main.ts` to import from `./tools` and delete the moved definitions, keeping the existing one-shot `-p` flow working exactly as before**

Replace the full contents of `app/main.ts` with:

```ts
import OpenAI from "openai";
import { TOOLS, getFunctionToolCalls, executeToolCall } from "./tools";

const MODEL = "anthropic/claude-haiku-4.5";

async function main() {
  const [, , flag, prompt] = process.argv;
  const apiKey = process.env.OPENROUTER_API_KEY;
  const baseURL =
    process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }
  if (flag !== "-p" || !prompt) {
    throw new Error("error: -p flag is required");
  }

  const client = new OpenAI({
    apiKey: apiKey,
    baseURL: baseURL,
  });

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "user", content: prompt },
  ];

  while (true) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: TOOLS,
    });

    if (!response.choices || response.choices.length === 0) {
      throw new Error("no choices in response");
    }

    const message = response.choices[0].message;
    messages.push(message);

    const toolCalls = getFunctionToolCalls(message);

    if (toolCalls.length === 0) {
      console.log(message.content);
      return;
    }

    for (const toolCall of toolCalls) {
      const result = executeToolCall(toolCall);
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }
}

main();
```

- [ ] **Step 3: Type-check**

Run: `bunx tsc --noEmit`
Expected: no output, exit code 0.

- [ ] **Step 4: Manual regression check — one-shot mode still behaves identically**

Run (with a real `OPENROUTER_API_KEY` exported or in `.env`):
```sh
./fraude-code.sh -p "Say the word: pineapple"
```
Expected: prints a response containing "pineapple". Then run one that exercises a tool:
```sh
./fraude-code.sh -p "Use the Read tool to read package.json and tell me the value of the name field"
```
Expected: prints a response naming `fraude-code`, confirming `Read` still executes correctly through the extracted module.

- [ ] **Step 5: Commit**

```sh
git add app/tools.ts app/main.ts
git commit -m "Extract tool schemas and execution into app/tools.ts"
```

---

### Task 2: Extract `app/agent.ts`

**Files:**
- Create: `app/agent.ts`
- Modify: `app/main.ts`

**Interfaces:**
- Consumes: `TOOLS`, `getFunctionToolCalls`, `executeToolCall` from `app/tools.ts` (Task 1).
- Produces:
  ```ts
  export type ToolCallEvent =
    | { phase: "start"; name: string; args: unknown }
    | { phase: "end"; name: string; result: string };

  export async function runAgentTurn(
    client: OpenAI,
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    onToolCall?: (event: ToolCallEvent) => void
  ): Promise<string>
  ```
  `runAgentTurn` mutates `messages` in place (via `.push`) and returns the final assistant text once the model responds with no further tool calls.

- [ ] **Step 1: Create `app/agent.ts`**

```ts
import OpenAI from "openai";
import { TOOLS, getFunctionToolCalls, executeToolCall } from "./tools";

const MODEL = "anthropic/claude-haiku-4.5";

export type ToolCallEvent =
  | { phase: "start"; name: string; args: unknown }
  | { phase: "end"; name: string; result: string };

export async function runAgentTurn(
  client: OpenAI,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  onToolCall?: (event: ToolCallEvent) => void
): Promise<string> {
  while (true) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: TOOLS,
    });

    if (!response.choices || response.choices.length === 0) {
      throw new Error("no choices in response");
    }

    const message = response.choices[0].message;
    messages.push(message);

    const toolCalls = getFunctionToolCalls(message);

    if (toolCalls.length === 0) {
      return message.content ?? "";
    }

    for (const toolCall of toolCalls) {
      const args = JSON.parse(toolCall.function.arguments);
      onToolCall?.({ phase: "start", name: toolCall.function.name, args });
      const result = executeToolCall(toolCall);
      onToolCall?.({ phase: "end", name: toolCall.function.name, result });
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }
}
```

- [ ] **Step 2: Update `app/main.ts` to call `runAgentTurn` instead of looping inline, still in one-shot `-p` mode**

Replace the full contents of `app/main.ts` with:

```ts
import OpenAI from "openai";
import { runAgentTurn } from "./agent";

async function main() {
  const [, , flag, prompt] = process.argv;
  const apiKey = process.env.OPENROUTER_API_KEY;
  const baseURL =
    process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }
  if (flag !== "-p" || !prompt) {
    throw new Error("error: -p flag is required");
  }

  const client = new OpenAI({
    apiKey: apiKey,
    baseURL: baseURL,
  });

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "user", content: prompt },
  ];

  const finalText = await runAgentTurn(client, messages);
  console.log(finalText);
}

main();
```

- [ ] **Step 3: Type-check**

Run: `bunx tsc --noEmit`
Expected: no output, exit code 0.

- [ ] **Step 4: Manual regression check**

Run the same two commands as Task 1 Step 4:
```sh
./fraude-code.sh -p "Say the word: pineapple"
./fraude-code.sh -p "Use the Read tool to read package.json and tell me the value of the name field"
```
Expected: identical behavior to before (a response containing "pineapple"; a response naming `fraude-code`) — confirms the loop extraction didn't change behavior.

- [ ] **Step 5: Commit**

```sh
git add app/agent.ts app/main.ts
git commit -m "Extract the agent loop into app/agent.ts as runAgentTurn"
```

---

### Task 3: Create `app/session-store.ts`

**Files:**
- Create: `app/session-store.ts`

**Interfaces:**
- Produces:
  ```ts
  export function loadSession(name: string): OpenAI.Chat.Completions.ChatCompletionMessageParam[]
  export function saveSession(name: string, messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): void
  ```

- [ ] **Step 1: Create `app/session-store.ts`**

```ts
import OpenAI from "openai";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const SESSIONS_DIR = join(homedir(), ".fraude", "sessions");

function sessionPath(name: string): string {
  return join(SESSIONS_DIR, `${name}.json`);
}

export function loadSession(
  name: string
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const path = sessionPath(name);
  if (!existsSync(path)) {
    return [];
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function saveSession(
  name: string,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(sessionPath(name), JSON.stringify(messages, null, 2), "utf-8");
}
```

- [ ] **Step 2: Type-check**

Run: `bunx tsc --noEmit`
Expected: no output, exit code 0.

- [ ] **Step 3: Write a temporary manual-verification script**

Create `app/session-store.manual-check.ts`:
```ts
import { loadSession, saveSession } from "./session-store";

const before = loadSession("plan-check");
console.log("before:", JSON.stringify(before));

saveSession("plan-check", [{ role: "user", content: "hello from manual check" }]);

const after = loadSession("plan-check");
console.log("after:", JSON.stringify(after));
```

- [ ] **Step 4: Run it and verify the round trip**

Run: `bun run app/session-store.manual-check.ts`
Expected output:
```
before: []
after: [{"role":"user","content":"hello from manual check"}]
```

- [ ] **Step 5: Verify the file on disk, then clean up**

Run: `cat ~/.fraude/sessions/plan-check.json`
Expected: a pretty-printed JSON array matching the `"after"` line above.

Run: `rm app/session-store.manual-check.ts ~/.fraude/sessions/plan-check.json`

- [ ] **Step 6: Commit**

```sh
git add app/session-store.ts
git commit -m "Add app/session-store.ts for persisting sessions to disk"
```

---

### Task 4: Install Ink/React and build a minimal interactive shell

**Files:**
- Modify: `package.json`, `bun.lock`
- Create: `app/ui/App.tsx`

**Interfaces:**
- Produces (this task): `export function App({ sessionName }: { sessionName: string })`, `export function startApp(sessionName: string): void` — both from `app/ui/App.tsx`. Task 5 modifies both to add real agent wiring.

- [ ] **Step 1: Install dependencies**

Run:
```sh
bun add ink react ink-text-input
bun add -d @types/react
```
Expected: `package.json` gains `ink`, `react`, `ink-text-input` under `dependencies` and `@types/react` under `devDependencies`; `bun.lock` is updated; `node_modules/ink`, `node_modules/react`, and `node_modules/ink-text-input` exist.

- [ ] **Step 2: Create `app/ui/App.tsx` — banner + input that echoes back, no model calls yet**

```tsx
import { useState } from "react";
import { render, Static, Box, Text } from "ink";
import TextInput from "ink-text-input";

type StaticEntry =
  | { type: "banner" }
  | { type: "user"; text: string }
  | { type: "assistant"; text: string };

export function App({ sessionName }: { sessionName: string }) {
  const [entries, setEntries] = useState<StaticEntry[]>([{ type: "banner" }]);
  const [input, setInput] = useState("");

  function handleSubmit(value: string) {
    const text = value.trim();
    if (!text) {
      return;
    }
    setInput("");
    setEntries((prev) => [
      ...prev,
      { type: "user", text },
      { type: "assistant", text: `echo: ${text}` },
    ]);
  }

  return (
    <Box flexDirection="column">
      <Static items={entries}>
        {(entry, index) => (
          <Box key={index}>
            {entry.type === "banner" && (
              <Text color="magenta">
                fraude-code — session "{sessionName}"{"\n"}
                Type a message and press Enter. Ctrl+C to exit.
              </Text>
            )}
            {entry.type === "user" && (
              <Text color="cyan">{"> "}{entry.text}</Text>
            )}
            {entry.type === "assistant" && <Text>{entry.text}</Text>}
          </Box>
        )}
      </Static>
      <Box>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          focus={!!process.stdin.isTTY}
        />
      </Box>
    </Box>
  );
}

export function startApp(sessionName: string) {
  render(<App sessionName={sessionName} />);
}
```

> **Note on the `focus` prop:** `ink-text-input` calls Ink's `useInput` internally, which tries to enable raw mode on the terminal as soon as the component mounts — and throws immediately if stdin isn't a real TTY (e.g. `bun run app.tsx < /dev/null`, or any non-interactive shell a script or subagent runs in). Passing `focus={!!process.stdin.isTTY}` skips that raw-mode setup when there's no real terminal, so the rest of the app can still render and be inspected headlessly. In a real terminal (`fraude` run normally), `process.stdin.isTTY` is `true` and this is a no-op — input behaves exactly as if the prop weren't there.

- [ ] **Step 3: Type-check**

Run: `bunx tsc --noEmit`
Expected: no output, exit code 0.

- [ ] **Step 4: Write a temporary harness and verify the shell renders without a real terminal**

Neither an automated implementer nor the plan's controller has a real TTY available, so this step verifies what's possible headlessly: that the component tree renders without crashing. Full interactive behavior (typing and seeing the echo) cannot be verified this way — it's confirmed later by a human running `fraude` in an actual terminal, once the full feature is wired up.

Create `app/ui/App.manual-check.tsx`:
```tsx
import { render } from "ink";
import { App } from "./App";

const { unmount } = render(<App sessionName="manual-check" />);
setTimeout(() => unmount(), 300);
```

Run: `bun run app/ui/App.manual-check.tsx < /dev/null`

Expected: the process exits cleanly (exit code 0) with no `ERROR Raw mode is not supported` output, and prints a line containing `fraude-code — session "manual-check"` and the usage hint — confirming the component tree mounts, renders `<Static>`'s banner entry, and the `focus`-guarded `<TextInput>` doesn't crash without a TTY.

- [ ] **Step 5: Clean up the harness**

Run: `rm app/ui/App.manual-check.tsx`

- [ ] **Step 6: Commit**

```sh
git add package.json bun.lock app/ui/App.tsx
git commit -m "Add Ink/React deps and a minimal interactive shell"
```

---

### Task 5: Wire `App.tsx` to the real agent loop and session persistence

**Files:**
- Modify: `app/ui/App.tsx`

**Interfaces:**
- Consumes: `runAgentTurn`, `ToolCallEvent` from `app/agent.ts` (Task 2); `saveSession` from `app/session-store.ts` (Task 3).
- Produces (final signatures for Task 6 to consume):
  ```ts
  export function App(props: {
    sessionName: string;
    client: OpenAI;
    initialMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  }): JSX.Element

  export function startApp(
    sessionName: string,
    client: OpenAI,
    initialMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
  ): void
  ```

- [ ] **Step 1: Replace `app/ui/App.tsx` with the full version wired to `runAgentTurn` and `saveSession`**

```tsx
import { useState, useRef } from "react";
import { render, Static, Box, Text } from "ink";
import TextInput from "ink-text-input";
import OpenAI from "openai";
import { runAgentTurn, type ToolCallEvent } from "../agent";
import { saveSession } from "../session-store";

type StaticEntry =
  | { type: "banner" }
  | { type: "user"; text: string }
  | { type: "tool"; name: string; args: unknown; result?: string }
  | { type: "assistant"; text: string }
  | { type: "error"; text: string };

type Status = "idle" | "thinking" | { tool: string };

interface AppProps {
  sessionName: string;
  client: OpenAI;
  initialMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
}

export function App({ sessionName, client, initialMessages }: AppProps) {
  const [entries, setEntries] = useState<StaticEntry[]>([{ type: "banner" }]);
  const messagesRef = useRef([...initialMessages]);
  const [status, setStatus] = useState<Status>("idle");
  const [input, setInput] = useState("");

  async function handleSubmit(value: string) {
    const text = value.trim();
    if (!text) {
      return;
    }
    setInput("");
    setEntries((prev) => [...prev, { type: "user", text }]);
    messagesRef.current.push({ role: "user", content: text });
    setStatus("thinking");

    const onToolCall = (event: ToolCallEvent) => {
      if (event.phase === "start") {
        setStatus({ tool: event.name });
        setEntries((prev) => [
          ...prev,
          { type: "tool", name: event.name, args: event.args },
        ]);
      } else {
        setEntries((prev) =>
          prev.map((entry, index) =>
            index === prev.length - 1 && entry.type === "tool"
              ? { ...entry, result: event.result }
              : entry
          )
        );
        setStatus("thinking");
      }
    };

    try {
      const finalText = await runAgentTurn(
        client,
        messagesRef.current,
        onToolCall
      );
      setEntries((prev) => [...prev, { type: "assistant", text: finalText }]);
      saveSession(sessionName, messagesRef.current);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setEntries((prev) => [...prev, { type: "error", text: message }]);
    } finally {
      setStatus("idle");
    }
  }

  return (
    <Box flexDirection="column">
      <Static items={entries}>
        {(entry, index) => (
          <Box key={index}>
            {entry.type === "banner" && (
              <Text color="magenta">
                fraude-code — session "{sessionName}"{"\n"}
                Type a message and press Enter. Ctrl+C to exit.
              </Text>
            )}
            {entry.type === "user" && (
              <Text color="cyan">{"> "}{entry.text}</Text>
            )}
            {entry.type === "tool" && (
              <Text color="yellow">
                → {entry.name}({JSON.stringify(entry.args)})
                {entry.result !== undefined ? ` → ${entry.result}` : ""}
              </Text>
            )}
            {entry.type === "assistant" && <Text>{entry.text}</Text>}
            {entry.type === "error" && (
              <Text color="red">Error: {entry.text}</Text>
            )}
          </Box>
        )}
      </Static>
      <Box>
        {status === "idle" ? (
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            focus={!!process.stdin.isTTY}
          />
        ) : (
          <Text color="gray">
            {status === "thinking" ? "thinking..." : `running ${status.tool}...`}
          </Text>
        )}
      </Box>
    </Box>
  );
}

export function startApp(
  sessionName: string,
  client: OpenAI,
  initialMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
) {
  render(
    <App
      sessionName={sessionName}
      client={client}
      initialMessages={initialMessages}
    />
  );
}
```

- [ ] **Step 2: Type-check**

Run: `bunx tsc --noEmit`
Expected: no output, exit code 0.

> **No TTY is available to run this verification interactively** (not in an automated implementer's shell, and not in the plan controller's either — confirmed by spiking Ink directly: `<TextInput>` crashes with "Raw mode is not supported" when stdin isn't a real terminal, which is exactly why Task 4 added the `focus` guard). Real keystroke-by-keystroke interactive confirmation happens once, by a human, in an actual terminal, after Task 6 wires up the full CLI — not in this task. This task instead verifies the real wiring (`handleSubmit` → `runAgentTurn` → state updates → `saveSession`) programmatically using `ink-testing-library`, which provides a mock stdin that delivers simulated keystrokes without needing a real TTY. This package is a **transient verification tool only** — install it, use it, then remove it before committing, so it never becomes a tracked project dependency (it is not in this plan's dependency list and the project has no persisted test suite).

- [ ] **Step 3: Install the transient verification tool**

Run: `bun add -d ink-testing-library`

- [ ] **Step 4: Write a temporary harness with a real client and verify the happy path end-to-end**

Create `app/ui/App.manual-check.tsx`:
```tsx
import { render } from "ink-testing-library";
import OpenAI from "openai";
import { App } from "./App";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  throw new Error("OPENROUTER_API_KEY is not set");
}
const client = new OpenAI({
  apiKey,
  baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
});

const { lastFrame, stdin } = render(
  <App sessionName="manual-check" client={client} initialMessages={[]} />
);

console.log("--- initial frame ---");
console.log(lastFrame());

stdin.write("Say the word: pineapple");
stdin.write("\r");
await new Promise((r) => setTimeout(r, 5000));
console.log("--- after first turn ---");
console.log(lastFrame());

stdin.write("Use the Read tool to read package.json and tell me the name field");
stdin.write("\r");
await new Promise((r) => setTimeout(r, 8000));
console.log("--- after tool-call turn ---");
console.log(lastFrame());
```

Run: `bun run --env-file=.env app/ui/App.manual-check.tsx < /dev/null`

Expected:
1. The initial frame contains `fraude-code — session "manual-check"` and the usage hint.
2. The frame after the first turn contains `> Say the word: pineapple` and an assistant line containing "pineapple".
3. The frame after the tool-call turn contains a line starting `→ Read({"file_path":"package.json"})` followed by a `→` and some result text, and an assistant line naming `fraude-code`.
4. Run `cat ~/.fraude/sessions/manual-check.json` — confirm it contains the full message history (user/assistant/tool messages) from both turns, proving `saveSession` ran.

If the timeouts above aren't long enough for the real API round trip, increase them and re-run rather than treating a truncated frame as a pass.

- [ ] **Step 5: Verify the error path with the same technique**

Create a second temporary harness, `app/ui/App.manual-check-error.tsx`:
```tsx
import { render } from "ink-testing-library";
import OpenAI from "openai";
import { App } from "./App";

const client = new OpenAI({
  apiKey: "sk-or-invalid-key",
  baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
});

const { lastFrame, stdin } = render(
  <App sessionName="manual-check-error" client={client} initialMessages={[]} />
);

stdin.write("hello");
stdin.write("\r");
await new Promise((r) => setTimeout(r, 5000));
console.log(lastFrame());
```

Run: `bun run app/ui/App.manual-check-error.tsx < /dev/null`

Expected: the printed frame contains a line starting `Error: ` (not a crash — the process exits normally after the script finishes). Then run `cat ~/.fraude/sessions/manual-check-error.json` — expected: the file does not exist, confirming the failed turn was correctly skipped by `saveSession`.

- [ ] **Step 6: Clean up the harnesses, their session files, and the transient dependency**

Run:
```sh
rm app/ui/App.manual-check.tsx app/ui/App.manual-check-error.tsx
rm -f ~/.fraude/sessions/manual-check.json ~/.fraude/sessions/manual-check-error.json
bun remove ink-testing-library
```
Confirm with `git status` and `git diff package.json bun.lock` that `ink-testing-library` is gone and no harness files remain untracked. If `bun remove` leaves any residual diff noise in `package.json` or `bun.lock` (e.g. formatting/ordering) rather than restoring them exactly to their pre-`bun add` state, run `git checkout -- package.json bun.lock` to discard it — this task's commit must not touch either file.

- [ ] **Step 7: Commit**

```sh
git add app/ui/App.tsx
git commit -m "Wire App.tsx to runAgentTurn and session persistence"
```

---

### Task 6: Rewrite `app/main.ts` as the thin entry point

**Files:**
- Modify: `app/main.ts`

**Interfaces:**
- Consumes: `startApp` from `app/ui/App.tsx` (Task 5); `loadSession` from `app/session-store.ts` (Task 3).

- [ ] **Step 1: Replace the full contents of `app/main.ts`**

```ts
import OpenAI from "openai";
import { startApp } from "./ui/App";
import { loadSession } from "./session-store";

function main() {
  const sessionName = process.argv[2] ?? "default";
  const apiKey = process.env.OPENROUTER_API_KEY;
  const baseURL =
    process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";

  if (!apiKey) {
    console.error("OPENROUTER_API_KEY is not set");
    process.exit(1);
  }

  const client = new OpenAI({ apiKey, baseURL });
  const initialMessages = loadSession(sessionName);

  startApp(sessionName, client, initialMessages);
}

main();
```

- [ ] **Step 2: Type-check**

Run: `bunx tsc --noEmit`
Expected: no output, exit code 0.

- [ ] **Step 3: Headless verification of `main.ts`'s own wiring**

The end-to-end agent loop and UI wiring (tool calls, session persistence, error handling) were already verified in Task 5, directly against `App.tsx`. What's new and untested in *this* task is narrower: does `main.ts` correctly parse the session-name argument, fail fast on a missing key, and pass the loaded session into `startApp`? Verify exactly that, headlessly (no TTY is available here — see Task 4/5's notes on why):

1. Missing key: run `env -u OPENROUTER_API_KEY bun run app/main.ts < /dev/null`. Expected: prints `OPENROUTER_API_KEY is not set` to stderr and exits with code 1 — *before* Ink ever renders (no "Raw mode" error, no Ink output at all).
2. Default session name: with a real key available, run `bun run app/main.ts < /dev/null` (no session-name argument). Expected: exits cleanly (the process will run until stdin closes, since there's no TTY to keep it open — that's fine) and its output contains `fraude-code — session "default"`.
3. Named session: run `bun run app/main.ts some-plan-check-session < /dev/null`. Expected: output contains `fraude-code — session "some-plan-check-session"` — confirming `process.argv[2]` is read correctly and passed through to `App`.
4. Run `rm -f ~/.fraude/sessions/some-plan-check-session.json` to clean up (step 3 may or may not have created it, depending on whether `loadSession` touches disk on a read of a nonexistent session — check the plan's Task 3 code: it doesn't create the file on a miss, only `saveSession` does, so this file likely won't exist; the `rm -f` is just a safety no-op either way).

- [ ] **Step 4: Note what remains for the human to confirm**

The following genuinely require a real terminal and are **not** achievable by an automated implementer or the plan's controller — flag this plainly in your report rather than attempting to fake it:
- Actually typing into `fraude` / `fraude-code.sh` and watching the banner, live responses, and tool-call lines render with real colors.
- Confirming the global `fraude` command (symlinked into `~/.bun/bin`) still works correctly from another directory now that the CLI contract changed from `-p "<prompt>"` to a positional session name.
- Confirming that resuming a named session (`fraude work`, exit, `fraude work` again) both loads prior history into the model's context *and* feels right interactively.

Do not mark these as verified — report them as outstanding, for the plan's controller to arrange a final human check after all tasks are done.

- [ ] **Step 5: Commit**

```sh
git add app/main.ts
git commit -m "Replace one-shot -p CLI with the interactive session entry point"
```

---

### Task 7: Update docs to reflect the shipped feature

**Files:**
- Modify: `README.md`, `docs/background.md`, `docs/requirements.md`, `docs/design.md`

- [ ] **Step 1: Update `README.md`**

Replace the "How it works" and "Usage" sections' one-shot framing. Find:
```
`app/main.ts` runs a single CLI prompt through an agent loop:
```
Replace with:
```
`app/main.ts` opens an interactive session through an agent loop:
```

Find the numbered one-shot description immediately below that line (starts `1. Send the conversation so far...`, ends `3. Repeat until the model responds with a plain answer instead of a tool call, then print that answer and exit.`) and replace its third item — the only one describing one-shot-specific behavior — so the list matches the interactive loop:
```
3. Once the model responds with a plain answer, print it and wait for
   your next message — repeating until you exit the session.
```
(Items 1 and 2 already describe the underlying agent loop accurately regardless of one-shot vs. interactive mode — only item 3's "then... exit" framing is one-shot-specific and needs replacing.)

Then find the `## Usage` section's:
```sh
./your_program.sh -p "your prompt here"
```
(or `fraude-code.sh` depending on current content — match whatever the file currently has) and replace the Usage section with:
```markdown
## Usage

```sh
./fraude-code.sh [session-name]
```

Or, using the global `fraude` command (see below): `fraude [session-name]`.

`session-name` is optional and defaults to `"default"`. Each session's
conversation history is saved to `~/.fraude/sessions/<session-name>.json`
and resumed automatically the next time you open that same session name.
```

- [ ] **Step 2: Update `docs/background.md`**

Find the "Current capabilities" section's one-shot bullet:
```
- One-shot CLI: `fraude -p "<prompt>"` runs a single prompt through the
  agent loop and prints the final answer.
```
Replace with:
```
- Interactive session CLI: `fraude [session-name]` opens a persistent
  chat session with a landing banner, backed by the same agent loop.
  Sessions persist to disk and resume across launches.
```

Find the "Where this is headed" section and replace its contents with:
```markdown
## Where this is headed

Interactive session mode shipped — see
[[superpowers/specs/2026-09-06-interactive-session-design|the design spec]]
for how it's built. Remaining open questions (Bash sandboxing, sync vs.
async tool execution) are tracked in
[[design#open-questions|Design → Open Questions]].
```

- [ ] **Step 3: Update `docs/requirements.md`**

Move the "Interactive session mode" section from "planned" to "shipped": find
```
## Functional requirements (planned)

### Interactive session mode {#interactive-session-mode}
```
and change the heading level/section it lives under so it reads as shipped — replace the `## Functional requirements (planned)` heading and the paragraph immediately above `### Interactive session mode` with:
```markdown
## Functional requirements (shipped)
```
i.e. merge it into the existing shipped list as an additional entry rather than its own subsection, and update the bullet describing the one-shot CLI (`- CLI accepts \`-p "<prompt>"\` for one-shot prompt execution.`) to:
```
- CLI accepts an optional `session-name` positional argument
  (`fraude [session-name]`, defaulting to `"default"`) and opens an
  interactive session instead of running one shot.
```

- [ ] **Step 4: Update `docs/design.md`**

In the "Open Questions" section, prefix questions 1-4 (TUI approach, session persistence across invocations, whether `-p` stays, OpenRouter vs. native SDK) with a resolved note. For each of questions 1-3, append after the existing text:
```
**Resolved** (2026-09-06): see
[[superpowers/specs/2026-09-06-interactive-session-design|the design spec]].
```
Leave question 4 (OpenRouter vs. native SDK) and questions 5-6 (sync/async, Bash sandboxing) unchanged — they remain open.

- [ ] **Step 5: Verify no stale references remain**

Run: `grep -rn '\-p "' README.md docs/background.md docs/requirements.md`
Expected: no output (no remaining references to the old `-p` flag usage in prose describing current behavior). It's fine if `docs/design.md` or the spec still mention `-p` when describing what was *removed* — that's historical record, not current-usage documentation.

- [ ] **Step 6: Commit**

```sh
git add README.md docs/background.md docs/requirements.md docs/design.md
git commit -m "Update docs for shipped interactive session mode"
```
