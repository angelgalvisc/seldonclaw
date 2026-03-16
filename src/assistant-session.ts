/**
 * assistant-session.ts — Persistent operator assistant sessions
 */

import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AssistantWorkspaceLayout } from "./assistant-workspace.js";

export type AssistantSessionMode = "design" | "shell";

export interface AssistantSession {
  id: string;
  path: string;
  createdAt: string;
  mode: AssistantSessionMode;
}

export interface AssistantSessionMessage {
  role: "system" | "user" | "assistant";
  content: string;
  timestamp: string;
}

type SessionEvent =
  | {
      type: "session_start";
      sessionId: string;
      createdAt: string;
      mode: AssistantSessionMode;
    }
  | ({
      type: "message";
    } & AssistantSessionMessage);

export function createAssistantSession(
  layout: AssistantWorkspaceLayout,
  mode: AssistantSessionMode = "design"
): AssistantSession {
  const createdAt = new Date().toISOString();
  const id = `${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const path = join(layout.sessionsDir, `${id}.jsonl`);
  const event: SessionEvent = {
    type: "session_start",
    sessionId: id,
    createdAt,
    mode,
  };
  writeFileSync(path, `${JSON.stringify(event)}\n`, "utf-8");
  return { id, path, createdAt, mode };
}

export function resetAssistantSession(
  layout: AssistantWorkspaceLayout,
  mode: AssistantSessionMode = "design"
): AssistantSession {
  return createAssistantSession(layout, mode);
}

export function appendAssistantMessage(
  session: AssistantSession,
  role: AssistantSessionMessage["role"],
  content: string
): void {
  const trimmed = content.trim();
  if (!trimmed) return;
  const event: SessionEvent = {
    type: "message",
    role,
    content: trimmed,
    timestamp: new Date().toISOString(),
  };
  appendFileSync(session.path, `${JSON.stringify(event)}\n`, "utf-8");
}

export function readRecentAssistantMessages(
  layout: AssistantWorkspaceLayout,
  limit: number
): AssistantSessionMessage[] {
  if (limit <= 0 || !existsSync(layout.sessionsDir)) return [];

  const files = readdirSync(layout.sessionsDir)
    .filter((file) => file.endsWith(".jsonl"))
    .sort()
    .reverse();
  const messages: AssistantSessionMessage[] = [];

  for (const file of files) {
    const path = join(layout.sessionsDir, file);
    const lines = readFileSync(path, "utf-8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const event = JSON.parse(lines[index]) as SessionEvent;
      if (event.type !== "message") continue;
      messages.push({
        role: event.role,
        content: event.content,
        timestamp: event.timestamp,
      });
      if (messages.length >= limit) {
        return messages.reverse();
      }
    }
  }

  return messages.reverse();
}
