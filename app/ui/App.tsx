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
