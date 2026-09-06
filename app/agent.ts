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
