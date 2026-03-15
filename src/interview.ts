/**
 * interview.ts — Actor interview module for SeldonClaw
 *
 * Provides functions for interviewing simulated actors:
 *   - formatActorContext: build natural-language context string
 *   - resolveActorByName: fuzzy-match actor by name/handle
 *   - interviewActor: single-shot interview
 *   - createInterviewSession / continueInterview: multi-turn interviews
 */

import type { GraphStore, ActorRow, ActorContext } from "./db.js";
import type { CognitionBackend } from "./cognition.js";

// ═══════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════

export interface InterviewResult {
  actorId: string;
  actorName: string;
  question: string;
  response: string;
}

export interface InterviewSession {
  actorId: string;
  actorName: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
}

// ═══════════════════════════════════════════════════════
// formatActorContext
// ═══════════════════════════════════════════════════════

/**
 * Build a natural-language string from ActorContext for use as LLM context.
 */
export function formatActorContext(context: ActorContext): string {
  const { actor, beliefs, topics, recentPosts, recentMemories } = context;
  const lines: string[] = [];

  lines.push(`Name: ${actor.name} | Handle: @${actor.handle ?? actor.name} | Archetype: ${actor.archetype}`);
  lines.push(`Personality: ${actor.personality}`);
  lines.push(`Stance: ${actor.stance} | Region: ${actor.region ?? "unknown"} | Language: ${actor.language}`);

  if (beliefs.length > 0) {
    lines.push(`Beliefs:`);
    for (const b of beliefs) {
      lines.push(`  ${b.topic}: ${b.sentiment > 0 ? "+" : ""}${b.sentiment.toFixed(2)}`);
    }
  }

  if (topics.length > 0) {
    lines.push(`Topics: ${topics.map(t => t.topic).join(", ")}`);
  }

  if (recentPosts.length > 0) {
    lines.push(`Recent posts:`);
    for (const p of recentPosts.slice(0, 5)) {
      const snippet = p.content.length > 80 ? p.content.slice(0, 80) + "..." : p.content;
      lines.push(`  "${snippet}" (${p.likes} likes)`);
    }
  }

  if (recentMemories.length > 0) {
    lines.push(`Recent memories:`);
    for (const memory of recentMemories.slice(0, 3)) {
      lines.push(`  [${memory.kind}] ${memory.summary}`);
    }
  }

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════
// resolveActorByName
// ═══════════════════════════════════════════════════════

/**
 * Resolve an actor by name or handle with fuzzy matching.
 *
 * Priority: exact name > handle > unambiguous partial name.
 * Throws on ambiguous or missing matches.
 */
export function resolveActorByName(
  store: GraphStore,
  runId: string,
  nameOrHandle: string
): ActorRow {
  const actors = store.getActorsByRun(runId);
  const query = nameOrHandle.replace(/^@/, "").toLowerCase();

  // 1. Exact name match (case-insensitive)
  const exactName = actors.find(a => a.name.toLowerCase() === query);
  if (exactName) return exactName;

  // 2. Handle match (with/without @)
  const handleMatch = actors.find(a => (a.handle ?? "").toLowerCase() === query);
  if (handleMatch) return handleMatch;

  // 3. Partial name match
  const partials = actors.filter(a => a.name.toLowerCase().includes(query));
  if (partials.length === 1) return partials[0];
  if (partials.length > 1) {
    const names = partials.map(a => a.name).join(", ");
    throw new Error(`Ambiguous actor name "${nameOrHandle}". Matches: ${names}`);
  }

  // 4. No match
  const available = actors.map(a => a.name).join(", ");
  throw new Error(`Actor not found: "${nameOrHandle}". Available: ${available}`);
}

// ═══════════════════════════════════════════════════════
// interviewActor — single-shot interview
// ═══════════════════════════════════════════════════════

/**
 * Conduct a single-shot interview with an actor.
 * Builds context from the store and delegates to the cognition backend.
 */
export async function interviewActor(
  store: GraphStore,
  runId: string,
  actorId: string,
  backend: CognitionBackend,
  question: string
): Promise<InterviewResult> {
  const actor = store.getActor(actorId);
  if (!actor) throw new Error(`Actor not found: ${actorId}`);

  const context = store.queryActorContext(actorId, runId);
  const contextStr = formatActorContext(context);
  const response = await backend.interview(contextStr, question);

  return {
    actorId,
    actorName: actor.name,
    question,
    response,
  };
}

// ═══════════════════════════════════════════════════════
// Multi-turn interview session
// ═══════════════════════════════════════════════════════

/**
 * Create a new multi-turn interview session for an actor.
 */
export function createInterviewSession(
  store: GraphStore,
  runId: string,
  actorId: string
): InterviewSession {
  const actor = store.getActor(actorId);
  if (!actor) throw new Error(`Actor not found: ${actorId}`);

  return {
    actorId,
    actorName: actor.name,
    history: [],
  };
}

/**
 * Continue a multi-turn interview session with a new question.
 * Appends conversation history to the context for continuity.
 */
export async function continueInterview(
  session: InterviewSession,
  store: GraphStore,
  runId: string,
  backend: CognitionBackend,
  question: string
): Promise<string> {
  const context = store.queryActorContext(session.actorId, runId);
  const contextStr = formatActorContext(context);

  // Build context with history
  let fullContext = contextStr;
  if (session.history.length > 0) {
    fullContext += "\n\nPrevious conversation:\n";
    for (const msg of session.history) {
      fullContext += `${msg.role === "user" ? "Researcher" : session.actorName}: ${msg.content}\n`;
    }
  }

  // The backend.interview() doesn't support chat history natively,
  // so we include it in the context string
  const response = await backend.interview(fullContext, question);

  // Append to session history
  session.history.push({ role: "user", content: question });
  session.history.push({ role: "assistant", content: response });

  return response;
}
