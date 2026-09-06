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
