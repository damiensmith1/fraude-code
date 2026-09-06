import OpenAI from "openai";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
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
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const backupPath = `${path}.bak`;
    renameSync(path, backupPath);
    console.error(
      `Warning: session "${name}" was corrupted (${message}). Backed up to ${backupPath}; starting fresh.`
    );
    return [];
  }
}

export function saveSession(
  name: string,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(sessionPath(name), JSON.stringify(messages, null, 2), "utf-8");
}
