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
