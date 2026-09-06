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
        <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
      </Box>
    </Box>
  );
}

export function startApp(sessionName: string) {
  render(<App sessionName={sessionName} />);
}
```

- [ ] **Step 3: Type-check**

Run: `bunx tsc --noEmit`
Expected: no output, exit code 0.

- [ ] **Step 4: Write a temporary harness and manually verify the shell renders and echoes**

Create `app/ui/App.manual-check.tsx`:
```tsx
import { startApp } from "./App";
startApp("manual-check");
```

Run: `bun run app/ui/App.manual-check.tsx`

Expected (interactively): a magenta banner reading `fraude-code — session "manual-check"` followed by the usage hint; typing `hi` and pressing Enter shows `> hi` then `echo: hi`, and the input box is still active for another message; pressing Ctrl+C exits the process.

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
          <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
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

- [ ] **Step 3: Write a temporary harness with a real client and manually verify end-to-end**

Create `app/ui/App.manual-check.tsx`:
```tsx
import OpenAI from "openai";
import { startApp } from "./App";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  throw new Error("OPENROUTER_API_KEY is not set");
}
const client = new OpenAI({
  apiKey,
  baseURL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
});

startApp("manual-check", client, []);
```

Run: `bun run --env-file=.env app/ui/App.manual-check.tsx`

Expected (interactively):
1. Banner renders.
2. Type `Say the word: pineapple` and press Enter — status line shows `thinking...`, then the assistant's reply (containing "pineapple") appears.
3. Type `Use the Read tool to read package.json and tell me the name field` — a yellow line `→ Read({"file_path":"package.json"}) → ...` appears (status briefly shows `running Read...`), followed by the assistant's answer naming `fraude-code`.
4. Ctrl+C exits.
5. Run `cat ~/.fraude/sessions/manual-check.json` — confirm it contains the full message history from the session (user/assistant/tool messages), proving `saveSession` ran.

- [ ] **Step 4: Manually verify the error path**

Exit the Step 3 harness (Ctrl+C), then relaunch it with an intentionally invalid key:

Run: `OPENROUTER_API_KEY=sk-or-invalid-key bun run app/ui/App.manual-check.tsx`

Type any message (e.g. `hello`) and press Enter.

Expected: the status line shows `thinking...` briefly, then a red `Error: ...` line appears in the transcript — the process does not crash, and the input box becomes active again immediately, so you can type another message without restarting. Ctrl+C to exit.

Run: `cat ~/.fraude/sessions/manual-check.json` — expected: either the file doesn't exist yet, or (if Step 3 already created it) its contents are unchanged from Step 3 — confirming the failed turn was correctly skipped by `saveSession`.

- [ ] **Step 5: Clean up the harness and its session file**

Run: `rm app/ui/App.manual-check.tsx ~/.fraude/sessions/manual-check.json`

- [ ] **Step 6: Commit**

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

- [ ] **Step 3: Full manual test pass (per the spec's Testing section)**

1. Run `./fraude-code.sh` — lands on session `"default"`, shows banner, accepts a message, gets a response.
2. Run `./fraude-code.sh work` — banner shows session `"work"`; confirm `~/.fraude/sessions/work.json` is created and is independent of `default.json`.
3. In the `work` session, send "Use the Write tool to write the text 'plan check' to /tmp/plan-check.txt" — confirm the tool-call line appears and `cat /tmp/plan-check.txt` shows `plan check`.
4. Exit (Ctrl+C), then re-run `./fraude-code.sh work` — send "What did I just ask you to write, and to which file?" — confirm the model's answer reflects the prior turn, proving persisted history round-trips back into the conversation.
5. Run `cd /tmp && fraude` (the global command, from a different working directory) — confirm it still opens session `"default"` correctly, proving `fraude-code.sh`'s existing symlink-resolution and `--env-file` handling need no changes for the new positional-arg CLI contract.
6. Clean up: `rm /tmp/plan-check.txt`.

- [ ] **Step 4: Commit**

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

Find the numbered one-shot description (the `1. Send... 2. If the model... 3. Repeat...` list) and the `## Usage` section's:
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
