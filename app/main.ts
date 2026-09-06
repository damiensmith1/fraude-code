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
