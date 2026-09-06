import OpenAI from "openai";
import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";

const MODEL = "anthropic/claude-haiku-4.5";

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
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
            description: "The path of the file to write to"
          },
          content: {
            type: "string",
            description: "The content to write to the file"
          }
        }
      }
    }
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
            description: "The command to execute"
          }
        }
      }
    }
  }
];

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

function getFunctionToolCalls(
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

function executeToolCall(
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

function runCommand(command: string): string {
  try {
    return execSync(command, { encoding: "utf-8" });
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; message: string };
    const output = `${execError.stdout ?? ""}${execError.stderr ?? ""}`;
    return output || `Command failed: ${execError.message}`;
  }
}

main();
