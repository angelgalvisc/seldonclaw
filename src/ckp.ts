/**
 * ckp.ts — CKP (ClawKernel Protocol) export/import module
 *
 * Export and import agent bundles in the CKP format.
 * Bundles include agent cards, beliefs, topics, memories, authored posts,
 * exposure history, decision traces, provenance, and persona.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import {
  projectAgentCard,
  type CkpAgentProjectionInput,
} from "@clawkernel/sdk";
import type { GraphStore } from "./store.js";
import type {
  ActorExposureSnapshot,
  ActorMemoryRow,
  ActorPostSnapshot,
  ActorRow,
  DecisionCacheRow,
} from "./types.js";
import { uuid } from "./ids.js";

// ═══════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════

export interface ExportResult {
  actorId: string;
  outDir: string;
  files: string[];
  memoriesExported: number;
  postsExported: number;
  exposuresExported: number;
  decisionsExported: number;
}

export interface ImportResult {
  actorId: string; // new UUID
  name: string;
  topicsImported: number;
  beliefsImported: number;
  memoriesImported: number;
  postsImported: number;
  exposuresImported: number;
  decisionsImported: number;
}

// ═══════════════════════════════════════════════════════
// scrubSecrets — recursive secret redaction
// ═══════════════════════════════════════════════════════

const SECRET_VALUE_RE = /^sk-|^Bearer |^ghp_|^xoxb-/;
const SECRET_TEXT_RE = /\b(sk-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+|ghp_[A-Za-z0-9]+|xoxb-[A-Za-z0-9-]+)\b/g;

/**
 * Deep-clone the input and redact any secret keys or values.
 * Never mutates the original object.
 */
export function scrubSecrets<T>(obj: T): T {
  const clone = structuredClone(obj);
  walk(clone);
  return clone;
}

export function scrubSecretsInText(text: string): string {
  return text.replace(SECRET_TEXT_RE, "[REDACTED]");
}

function walk(node: unknown): void {
  if (node === null || node === undefined) return;
  if (typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      if (typeof node[i] === "string" && SECRET_VALUE_RE.test(node[i])) {
        node[i] = "[REDACTED]";
      } else if (typeof node[i] === "string") {
        node[i] = scrubSecretsInText(node[i]);
      } else {
        walk(node[i]);
      }
    }
    return;
  }

  const record = node as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const value = record[key];

    // Redact by key name
    if (looksLikeSecretKey(key) && typeof value === "string") {
      record[key] = "[REDACTED]";
      continue;
    }

    // Redact string values matching known secret prefixes
    if (typeof value === "string" && SECRET_VALUE_RE.test(value)) {
      record[key] = "[REDACTED]";
      continue;
    }

    if (typeof value === "string") {
      record[key] = scrubSecretsInText(value);
      continue;
    }

    // Recurse into nested objects/arrays
    if (typeof value === "object" && value !== null) {
      walk(value);
    }
  }
}

function looksLikeSecretKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.length === 0) return false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (
      token === "token" ||
      token === "secret" ||
      token === "bearer" ||
      token === "password" ||
      token === "credential" ||
      token === "credentials" ||
      token === "authorization"
    ) {
      return true;
    }
    if (token === "api" && tokens[i + 1] === "key") return true;
    if (token === "auth" && tokens[i + 1] !== "or") return true;
  }

  return false;
}

// ═══════════════════════════════════════════════════════
// exportAgent — write CKP bundle to disk
// ═══════════════════════════════════════════════════════

export function exportAgent(
  store: GraphStore,
  runId: string,
  actorId: string,
  outDir: string,
): ExportResult {
  // 1. Get actor
  const actor = store.getActor(actorId);
  if (!actor) {
    throw new Error("Actor not found: " + actorId);
  }

  // 2. Get context and actor experience
  const context = store.queryActorContext(actorId, runId);
  const memories = store.listActorMemories(actorId, runId);
  const posts = store.listActorPostSnapshots(actorId, runId);
  const exposures = store.listActorExposureSnapshots(actorId, runId);
  const decisions = store.listActorDecisionCache(actorId, runId);

  // 3. Get provenance if entity_id exists
  let provenance: unknown;
  if (actor.entity_id) {
    provenance = store.queryProvenance(actor.entity_id);
  } else {
    provenance = { entity: null, claims: [], chunks: [], documents: [] };
  }

  // 4. Build CKP agent card
  const input: CkpAgentProjectionInput = {
    name: actor.name,
    version: "0.1.0",
    personality: actor.personality,
  };
  const agentCard = projectAgentCard(input);

  // 5. Create output directory
  mkdirSync(outDir, { recursive: true });

  // 6. Build file contents
  const clawYaml = YAML.stringify(scrubSecrets({
    apiVersion: "ckp/v1alpha1",
    kind: "AgentCard",
    ...agentCard,
  }));

  const actorState = {
    stance: actor.stance,
    sentiment_bias: actor.sentiment_bias,
    influence_weight: actor.influence_weight,
    activity_level: actor.activity_level,
    follower_count: actor.follower_count,
    following_count: actor.following_count,
  };

  const beliefs = context.beliefs;
  const topics = context.topics;

  const manifest = {
    run_id: runId,
    actor_id: actorId,
    round: null,
    version: "0.1.0",
    exported_at: new Date().toISOString(),
    memories_exported: memories.length,
    posts_exported: posts.length,
    exposures_exported: exposures.length,
    decisions_exported: decisions.length,
  };

  // 7. Write files (scrub secrets from all JSON)
  const files = [
    "claw.yaml",
    "actor_state.json",
    "beliefs.json",
    "topics.json",
    "memories.json",
    "posts.json",
    "exposures.json",
    "decisions.json",
    "provenance.json",
    "persona.md",
    "manifest.meta.json",
  ];

  writeFileSync(join(outDir, "claw.yaml"), clawYaml, "utf-8");
  writeFileSync(
    join(outDir, "actor_state.json"),
    JSON.stringify(scrubSecrets(actorState), null, 2),
    "utf-8",
  );
  writeFileSync(
    join(outDir, "beliefs.json"),
    JSON.stringify(scrubSecrets(beliefs), null, 2),
    "utf-8",
  );
  writeFileSync(
    join(outDir, "topics.json"),
    JSON.stringify(scrubSecrets(topics), null, 2),
    "utf-8",
  );
  writeFileSync(
    join(outDir, "memories.json"),
    JSON.stringify(scrubSecrets(memories.map(toPortableMemory)), null, 2),
    "utf-8",
  );
  writeFileSync(
    join(outDir, "posts.json"),
    JSON.stringify(scrubSecrets(posts.map(toPortablePost)), null, 2),
    "utf-8",
  );
  writeFileSync(
    join(outDir, "exposures.json"),
    JSON.stringify(scrubSecrets(exposures.map(toPortableExposure)), null, 2),
    "utf-8",
  );
  writeFileSync(
    join(outDir, "decisions.json"),
    JSON.stringify(scrubSecrets(decisions.map(toPortableDecision)), null, 2),
    "utf-8",
  );
  writeFileSync(
    join(outDir, "provenance.json"),
    JSON.stringify(scrubSecrets(provenance), null, 2),
    "utf-8",
  );
  writeFileSync(
    join(outDir, "persona.md"),
    scrubSecretsInText(actor.personality),
    "utf-8",
  );
  writeFileSync(
    join(outDir, "manifest.meta.json"),
    JSON.stringify(scrubSecrets(manifest), null, 2),
    "utf-8",
  );

  return {
    actorId,
    outDir,
    files,
    memoriesExported: memories.length,
    postsExported: posts.length,
    exposuresExported: exposures.length,
    decisionsExported: decisions.length,
  };
}

// ═══════════════════════════════════════════════════════
// importAgent — read CKP bundle from disk into store
// ═══════════════════════════════════════════════════════

const REQUIRED_FILES = [
  "claw.yaml",
  "actor_state.json",
  "beliefs.json",
  "topics.json",
];

export function importAgent(
  store: GraphStore,
  runId: string,
  bundleDir: string,
): ImportResult {
  // 1. Validate required files exist
  for (const filename of REQUIRED_FILES) {
    if (!existsSync(join(bundleDir, filename))) {
      throw new Error("Missing required file: " + filename);
    }
  }

  // 2. Read and parse
  const agentCard = YAML.parse(
    readFileSync(join(bundleDir, "claw.yaml"), "utf-8"),
  );
  const actorState = JSON.parse(
    readFileSync(join(bundleDir, "actor_state.json"), "utf-8"),
  );
  const beliefs = JSON.parse(
    readFileSync(join(bundleDir, "beliefs.json"), "utf-8"),
  ) as Array<{ topic: string; sentiment: number }>;
  const topics = JSON.parse(
    readFileSync(join(bundleDir, "topics.json"), "utf-8"),
  ) as Array<{ topic: string; weight: number }>;
  const memoriesPath = join(bundleDir, "memories.json");
  const memories = existsSync(memoriesPath)
    ? (JSON.parse(readFileSync(memoriesPath, "utf-8")) as PortableActorMemory[])
    : [];
  const postsPath = join(bundleDir, "posts.json");
  const posts = existsSync(postsPath)
    ? (JSON.parse(readFileSync(postsPath, "utf-8")) as PortableActorPost[])
    : [];
  const exposuresPath = join(bundleDir, "exposures.json");
  const exposures = existsSync(exposuresPath)
    ? (JSON.parse(readFileSync(exposuresPath, "utf-8")) as PortableActorExposure[])
    : [];
  const decisionsPath = join(bundleDir, "decisions.json");
  const decisions = existsSync(decisionsPath)
    ? (JSON.parse(readFileSync(decisionsPath, "utf-8")) as PortableDecisionTrace[])
    : [];

  // Read persona.md if it exists
  const personaMdPath = join(bundleDir, "persona.md");
  const personaMd = existsSync(personaMdPath)
    ? readFileSync(personaMdPath, "utf-8")
    : "";

  // 3. Generate new UUID
  const newId = uuid();

  // 4. Build ActorRow
  const actor: ActorRow = {
    id: newId,
    run_id: runId,
    entity_id: null,
    archetype: agentCard.name?.includes("media") ? "media" : "persona",
    cognition_tier: "B",
    name: agentCard.name ?? "Imported Actor",
    handle: null,
    personality: personaMd ?? "",
    bio: agentCard.description ?? null,
    age: null,
    gender: null,
    profession: null,
    region: null,
    language: "en",
    stance: actorState.stance ?? "neutral",
    sentiment_bias: actorState.sentiment_bias ?? 0,
    activity_level: actorState.activity_level ?? 0.5,
    influence_weight: actorState.influence_weight ?? 0.1,
    community_id: null,
    active_hours: null,
    follower_count: actorState.follower_count ?? 0,
    following_count: actorState.following_count ?? 0,
  };

  // 5. Persist actor
  store.addActor(actor);

  // 6. Import beliefs
  for (const belief of beliefs) {
    store.addActorBelief(newId, belief.topic, belief.sentiment);
  }

  // 7. Import topics
  for (const topic of topics) {
    store.addActorTopic(newId, topic.topic, topic.weight);
  }

  // 8. Import memories when present. Source references are nulled because the
  // destination run does not include the original posts/actors by default.
  for (const memory of memories) {
    store.addActorMemory({
      id: uuid(),
      run_id: runId,
      actor_id: newId,
      round_num: Number.isFinite(memory.round_num) ? memory.round_num : 0,
      kind: isPortableMemoryKind(memory.kind) ? memory.kind : "reflection",
      summary: String(memory.summary ?? "").trim() || "Imported actor memory",
      salience: typeof memory.salience === "number" ? memory.salience : 0.5,
      topic: memory.topic ?? null,
      source_post_id: null,
      source_actor_id: null,
    });
  }

  for (const post of posts) {
    store.addActorMemory({
      id: uuid(),
      run_id: runId,
      actor_id: newId,
      round_num: Number.isFinite(post.round_num) ? post.round_num : 0,
      kind: "reflection",
      summary: summarizePortablePost(post),
      salience: derivePortablePostSalience(post),
      topic: post.topics[0] ?? null,
      source_post_id: null,
      source_actor_id: null,
    });
  }

  for (const exposure of exposures) {
    store.addActorMemory({
      id: uuid(),
      run_id: runId,
      actor_id: newId,
      round_num: Number.isFinite(exposure.round_num) ? exposure.round_num : 0,
      kind: "interaction",
      summary: summarizePortableExposure(exposure),
      salience: derivePortableExposureSalience(exposure),
      topic: exposure.post_topics[0] ?? null,
      source_post_id: null,
      source_actor_id: null,
    });
  }

  for (const decision of decisions) {
    store.addActorMemory({
      id: uuid(),
      run_id: runId,
      actor_id: newId,
      round_num: Number.isFinite(decision.round_num) ? decision.round_num : 0,
      kind: "reflection",
      summary: summarizePortableDecision(decision),
      salience: derivePortableDecisionSalience(decision),
      topic: decision.topics?.[0] ?? null,
      source_post_id: null,
      source_actor_id: null,
    });
  }

  // 9. Return result
  return {
    actorId: newId,
    name: actor.name,
    topicsImported: topics.length,
    beliefsImported: beliefs.length,
    memoriesImported: memories.length,
    postsImported: posts.length,
    exposuresImported: exposures.length,
    decisionsImported: decisions.length,
  };
}

type PortableActorMemory = {
  kind: string;
  round_num: number;
  summary: string;
  salience: number;
  topic?: string | null;
  source_post_id?: string | null;
  source_actor_id?: string | null;
  created_at?: string;
};

type PortableActorPost = {
  id: string;
  round_num: number;
  sim_timestamp: string;
  post_kind: "post" | "comment" | "repost" | "quote";
  content: string;
  reply_to?: string | null;
  quote_of?: string | null;
  likes: number;
  reposts: number;
  comments: number;
  reach: number;
  sentiment?: number | null;
  is_deleted?: boolean;
  deleted_at?: string | null;
  moderation_status?: "none" | "flagged" | "shadowed";
  topics: string[];
};

type PortableActorExposure = {
  actor_id: string;
  post_id: string;
  round_num: number;
  reaction: "seen" | "liked" | "commented" | "reposted";
  post_author_id: string;
  post_content: string;
  post_topics: string[];
  post_kind?: "post" | "comment" | "repost" | "quote";
  post_sentiment?: number | null;
  post_sim_timestamp: string;
};

type PortableDecisionTrace = {
  round_num: number;
  model_id: string;
  prompt_version: string;
  request_hash: string;
  action?: string;
  target?: string;
  content?: string;
  reasoning?: string;
  raw_response?: string;
  tokens_input?: number | null;
  tokens_output?: number | null;
  duration_ms?: number | null;
  topics?: string[];
};

function toPortableMemory(memory: ActorMemoryRow): PortableActorMemory {
  return {
    kind: memory.kind,
    round_num: memory.round_num,
    summary: memory.summary,
    salience: memory.salience,
    topic: memory.topic ?? null,
    source_post_id: memory.source_post_id ?? null,
    source_actor_id: memory.source_actor_id ?? null,
    created_at: memory.created_at,
  };
}

function toPortablePost(post: ActorPostSnapshot): PortableActorPost {
  return {
    id: post.id,
    round_num: post.round_num,
    sim_timestamp: post.sim_timestamp,
    post_kind: post.post_kind ?? "post",
    content: post.content,
    reply_to: post.reply_to ?? null,
    quote_of: post.quote_of ?? null,
    likes: post.likes,
    reposts: post.reposts,
    comments: post.comments,
    reach: post.reach,
    sentiment: post.sentiment ?? null,
    is_deleted: Boolean(post.is_deleted),
    deleted_at: post.deleted_at ?? null,
    moderation_status: post.moderation_status ?? "none",
    topics: post.topics,
  };
}

function toPortableExposure(exposure: ActorExposureSnapshot): PortableActorExposure {
  return {
    actor_id: exposure.actor_id,
    post_id: exposure.post_id,
    round_num: exposure.round_num,
    reaction: exposure.reaction,
    post_author_id: exposure.post_author_id,
    post_content: exposure.post_content,
    post_topics: exposure.post_topics,
    post_kind: exposure.post_kind ?? "post",
    post_sentiment: exposure.post_sentiment ?? null,
    post_sim_timestamp: exposure.post_sim_timestamp,
  };
}

function toPortableDecision(entry: DecisionCacheRow): PortableDecisionTrace {
  const parsed = parseDecisionTrace(entry.parsed_decision);
  return {
    round_num: entry.round_num,
    model_id: entry.model_id,
    prompt_version: entry.prompt_version,
    request_hash: entry.request_hash,
    action: parsed.action,
    target: parsed.target,
    content: parsed.content,
    reasoning: parsed.reasoning,
    raw_response: entry.raw_response,
    tokens_input: entry.tokens_input ?? null,
    tokens_output: entry.tokens_output ?? null,
    duration_ms: entry.duration_ms ?? null,
    topics: inferTopicsFromDecision(parsed),
  };
}

function parseDecisionTrace(
  parsedDecision: string
): Partial<{
  action: string;
  target: string;
  content: string;
  reasoning: string;
}> {
  try {
    const parsed = JSON.parse(parsedDecision) as Record<string, unknown>;
    return {
      action: typeof parsed.action === "string" ? parsed.action : undefined,
      target: typeof parsed.target === "string" ? parsed.target : undefined,
      content: typeof parsed.content === "string" ? parsed.content : undefined,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : undefined,
    };
  } catch {
    return {};
  }
}

function inferTopicsFromDecision(
  parsed: Partial<{
    content: string;
    reasoning: string;
  }>
): string[] {
  const text = [parsed.content, parsed.reasoning]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
  if (!text) return [];

  const tokens = text
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
  return [...new Set(tokens)].slice(0, 3);
}

function summarizePortablePost(post: PortableActorPost): string {
  const snippet = truncate(post.content, 120);
  if (post.post_kind === "quote") {
    return `You published a quote post in round ${post.round_num}: "${snippet}"`;
  }
  if (post.post_kind === "repost") {
    return `You reposted content in round ${post.round_num}: "${snippet}"`;
  }
  if (post.post_kind === "comment") {
    return `You commented in round ${post.round_num}: "${snippet}"`;
  }
  return `You authored a post in round ${post.round_num}: "${snippet}"`;
}

function derivePortablePostSalience(post: PortableActorPost): number {
  const engagement = post.likes + post.reposts * 2 + post.comments * 2;
  return clamp(0.45 + Math.min(0.35, engagement * 0.02) + Math.min(0.2, post.reach * 0.0015));
}

function summarizePortableExposure(exposure: PortableActorExposure): string {
  const snippet = truncate(exposure.post_content, 110);
  return `You ${exposure.reaction} a ${exposure.post_kind ?? "post"} from ${exposure.post_author_id} in round ${exposure.round_num}: "${snippet}"`;
}

function derivePortableExposureSalience(exposure: PortableActorExposure): number {
  const reactionWeight =
    exposure.reaction === "reposted"
      ? 0.95
      : exposure.reaction === "commented"
        ? 0.85
        : exposure.reaction === "liked"
          ? 0.72
          : 0.55;
  return clamp(reactionWeight + (exposure.post_sentiment ? Math.min(0.05, Math.abs(exposure.post_sentiment) * 0.05) : 0));
}

function summarizePortableDecision(decision: PortableDecisionTrace): string {
  const action = decision.action ?? "act";
  const reason = decision.reasoning?.trim();
  if (reason) {
    return `Decision trace from round ${decision.round_num}: ${truncate(reason, 160)}`;
  }
  if (decision.content?.trim()) {
    return `Decision trace from round ${decision.round_num}: you chose ${action} with content "${truncate(decision.content, 110)}"`;
  }
  if (decision.target) {
    return `Decision trace from round ${decision.round_num}: you chose ${action} targeting ${decision.target}.`;
  }
  return `Decision trace from round ${decision.round_num}: you chose ${action}.`;
}

function derivePortableDecisionSalience(decision: PortableDecisionTrace): number {
  const activeAction = decision.action && decision.action !== "idle" ? 0.8 : 0.58;
  const durationBoost = decision.duration_ms ? Math.min(0.08, decision.duration_ms / 20000) : 0;
  const tokenBoost =
    (decision.tokens_input ?? 0) + (decision.tokens_output ?? 0) > 0
      ? Math.min(0.07, ((decision.tokens_input ?? 0) + (decision.tokens_output ?? 0)) / 12000)
      : 0;
  return clamp(activeAction + durationBoost + tokenBoost);
}

function truncate(text: string, maxLength: number): string {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(0, maxLength - 3) + "...";
}

function clamp(value: number): number {
  return Math.max(0, Math.min(0.99, value));
}

function isPortableMemoryKind(
  kind: string
): kind is ActorMemoryRow["kind"] {
  return (
    kind === "reflection" ||
    kind === "interaction" ||
    kind === "narrative" ||
    kind === "event"
  );
}
