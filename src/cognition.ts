/**
 * cognition.ts — CognitionRouter + DecisionPolicy + CognitionBackend interface
 *
 * Source of truth: PLAN.md §Cognition: 3 Separate Layers (lines 992-1036),
 *                  §Interaction Summary (lines 1240-1278),
 *                  §Shared Types (lines 1212-1238)
 *
 * 3-layer design:
 *   Layer 1: CognitionRouter — which tier? (A/B/C)
 *   Layer 2: DecisionPolicy — rules for Tier C (no LLM)
 *   Layer 3: CognitionBackend — how are Tier A/B executed?
 *
 * CKP integration:
 *   - DecisionRequest/Response align with CKP TaskMessage semantics
 *   - DirectLLMBackend caches decisions for RecordedBackend replay
 *   - Actor context can be projected to CKP AgentCard via @clawkernel/sdk
 */

import { createHash } from "node:crypto";
import type {
  ActorRow,
  FeedItem,
  GraphStore,
  PostSnapshot,
  PRNG,
  SimEvent,
} from "./db.js";
import { stableId } from "./db.js";
import type { CognitionConfig } from "./config.js";
import type { LLMClient, LLMResponse } from "./llm.js";
import { hashDecisionRequest, hashString } from "./reproducibility.js";

// ═══════════════════════════════════════════════════════
// TYPES — from PLAN.md §Shared Types
// ═══════════════════════════════════════════════════════

export type CognitionTier = "A" | "B" | "C";

export interface CognitionRoute {
  tier: CognitionTier;
  reason: string;
}

export interface DecisionRequest {
  actorId: string;
  roundNum: number;
  actor: {
    name: string;
    personality: string;
    stance: string;
    gender?: string;
    region?: string;
    language: string;
    topics: string[];
    belief_state: Record<string, number>;
  };
  feed: FeedItem[];
  availableActions: string[];
  platform: "x";
  simContext: string;
  webContext?: string;
}

export interface DecisionResponse {
  action: "post" | "comment" | "repost" | "like" | "follow" | "search" | "idle";
  content?: string;
  target?: string;
  reasoning?: string;
}

// ═══════════════════════════════════════════════════════
// CognitionBackend — interface (Layer 3)
// ═══════════════════════════════════════════════════════

/**
 * Backend interface for executing Tier A/B decisions.
 * Implementations: DirectLLMBackend, RecordedBackend, MockBackend.
 *
 * Aligns with CKP task semantics:
 *   start() = lifecycle READY
 *   decide() = task create → complete
 *   shutdown() = lifecycle STOPPED
 */
export interface CognitionBackend {
  start(): Promise<void>;
  shutdown(): Promise<void>;
  decide(request: DecisionRequest): Promise<DecisionResponse>;
  interview(actorContext: string, question: string): Promise<string>;
}

// ═══════════════════════════════════════════════════════
// Layer 1: CognitionRouter — which tier?
// ═══════════════════════════════════════════════════════

/**
 * Route an actor to cognition tier A, B, or C.
 *
 * Tier A: ALWAYS backend (key actors)
 *   - influence_weight >= config.tierA.minInfluence
 *   - archetype in config.tierA.archetypeOverrides
 *
 * Tier B: Backend ONLY if high salience
 *   - Random sampling at config.tierB.samplingRate
 *   - OR relevant event in the current round
 *
 * Tier C: Pure rules — no backend
 *   - Everyone else
 */
export function routeCognition(
  actor: ActorRow,
  feed: FeedItem[],
  config: CognitionConfig,
  rng: PRNG,
  activeEvents?: SimEvent[],
  actorTopics?: string[]
): CognitionRoute {
  // Tier A: high influence or archetype override
  if (actor.influence_weight >= config.tierA.minInfluence) {
    return { tier: "A", reason: `influence=${actor.influence_weight.toFixed(2)} >= ${config.tierA.minInfluence}` };
  }
  if (config.tierA.archetypeOverrides.includes(actor.archetype)) {
    return { tier: "A", reason: `archetype=${actor.archetype} in overrides` };
  }

  // Tier B: salience check
  if (activeEvents && activeEvents.length > 0) {
    // Direct mention in event → Tier B
    const mentioned = activeEvents.some(e => e.actor_id === actor.id);
    if (mentioned) {
      return { tier: "B", reason: "mentioned in active event" };
    }

    // Event touches actor's topics → Tier B
    if (actorTopics && actorTopics.length > 0) {
      const topicSet = new Set(actorTopics);
      const topicMatch = activeEvents.some(
        e => e.topics.some(t => topicSet.has(t))
      );
      if (topicMatch) {
        return { tier: "B", reason: "active event touches actor topics" };
      }
    }
  }

  // Feed has a direct reply to this actor → higher Tier B chance
  const hasReply = feed.some(f => f.post.replyTo === actor.id);
  if (hasReply) {
    return { tier: "B", reason: "direct reply in feed" };
  }

  // Random sampling for Tier B
  if (rng.next() < config.tierB.samplingRate) {
    return { tier: "B", reason: `random sampling (rate=${config.tierB.samplingRate})` };
  }

  // Tier C: rules only
  return { tier: "C", reason: "default (low influence, no salience)" };
}

// ═══════════════════════════════════════════════════════
// Layer 2: DecisionPolicy — Tier C rules (no LLM)
// ═══════════════════════════════════════════════════════

/**
 * Apply rule-based decision for Tier C actors.
 * Uses PRNG for deterministic behavior — never Math.random().
 *
 * Rules:
 *   - Viral post in feed → repost with P=config.tierC.repostProb
 *   - Aligned post from followed → like with P=config.tierC.likeProb
 *   - Otherwise → idle
 */
export function applyTierCRules(
  actor: ActorRow,
  feed: FeedItem[],
  config: CognitionConfig,
  rng: PRNG
): DecisionResponse {
  // Sort feed by score descending for deterministic top pick
  const sorted = [...feed].sort((a, b) => b.score - a.score);

  for (const item of sorted) {
    // High-engagement post → consider repost
    if (item.post.likes + item.post.reposts > 5) {
      if (rng.next() < config.tierC.repostProb) {
        return {
          action: "repost",
          target: item.post.id,
          reasoning: "tier-C rule: viral repost",
        };
      }
    }

    // Aligned sentiment → consider like
    const aligned = (actor.sentiment_bias >= 0 && item.post.sentiment >= 0) ||
                    (actor.sentiment_bias < 0 && item.post.sentiment < 0);
    if (aligned && item.source === "follow") {
      if (rng.next() < config.tierC.likeProb) {
        return {
          action: "like",
          target: item.post.id,
          reasoning: "tier-C rule: aligned like",
        };
      }
    }
  }

  return {
    action: "idle",
    reasoning: "tier-C rule: no matching rule fired",
  };
}

// ═══════════════════════════════════════════════════════
// DirectLLMBackend — CognitionBackend using llm.ts
// ═══════════════════════════════════════════════════════

export interface DirectLLMConfig {
  promptVersion: string;
  runId: string;
}

/**
 * CognitionBackend that calls llm.ts directly for Tier A/B decisions.
 * No NullClaw dependency — uses Anthropic SDK through LLMClient.
 *
 * CKP alignment:
 *   - Decision messages structured as CKP-compatible content blocks
 *   - Responses cached in decision_cache for RecordedBackend replay
 *   - Model and provider tracked per CKP Provider primitive
 */
export class DirectLLMBackend implements CognitionBackend {
  constructor(
    private llm: LLMClient,
    private store: GraphStore,
    private config: DirectLLMConfig
  ) {}

  async start(): Promise<void> {
    // Verify the simulation provider is available
    if (!this.llm.hasProvider("simulation")) {
      throw new Error(
        "DirectLLMBackend requires the 'simulation' provider. " +
        "Set the API key for the simulation provider in your environment."
      );
    }
  }

  async shutdown(): Promise<void> {
    // No-op — no external process
  }

  async decide(request: DecisionRequest): Promise<DecisionResponse> {
    const systemPrompt = buildDecisionSystemPrompt(request);
    const userPrompt = buildDecisionUserPrompt(request);

    const response = await this.llm.completeJSON<DecisionResponse>(
      "simulation",
      userPrompt,
      {
        system: systemPrompt,
        temperature: 0.7,
        maxTokens: 512,
      }
    );

    // Validate response
    const decision = validateDecisionResponse(response.data);

    // Cache for reproducibility
    this.cacheDecision(request, decision, response.meta);

    return decision;
  }

  async interview(actorContext: string, question: string): Promise<string> {
    const systemPrompt =
      `You are a simulated social media user being interviewed by a researcher.\n\n` +
      `YOUR PERSONA:\n${actorContext}\n\n` +
      `Stay in character. Answer honestly based on your persona's beliefs, ` +
      `experiences, and worldview. Be conversational and authentic.`;

    const response = await this.llm.complete("simulation", question, {
      system: systemPrompt,
      temperature: 0.8,
      maxTokens: 1024,
    });

    // Cache interview for replay
    const hash = hashString(`interview|${actorContext}|${question}`);
    this.store.cacheDecision({
      id: stableId("interview", this.config.runId, hash),
      run_id: this.config.runId,
      round_num: 0,
      actor_id: "interview",
      request_hash: hash,
      raw_response: response.content,
      parsed_decision: JSON.stringify({ interview: true }),
      model_id: response.model,
      prompt_version: this.config.promptVersion,
      tokens_input: response.inputTokens,
      tokens_output: response.outputTokens,
      duration_ms: response.durationMs,
    });

    return response.content;
  }

  private cacheDecision(
    request: DecisionRequest,
    decision: DecisionResponse,
    meta: Omit<LLMResponse, "content">
  ): void {
    const requestHash = hashDecisionRequest(request);
    this.store.cacheDecision({
      id: stableId("decision", this.config.runId, requestHash, String(request.roundNum)),
      run_id: this.config.runId,
      round_num: request.roundNum,
      actor_id: request.actorId,
      request_hash: requestHash,
      raw_response: JSON.stringify(decision),
      parsed_decision: JSON.stringify(decision),
      model_id: meta.model,
      prompt_version: this.config.promptVersion,
      tokens_input: meta.inputTokens,
      tokens_output: meta.outputTokens,
      duration_ms: meta.durationMs,
    });
  }
}

// ═══════════════════════════════════════════════════════
// MockBackend — for tests without LLM
// ═══════════════════════════════════════════════════════

/**
 * CognitionBackend for testing. Returns deterministic canned decisions.
 */
export class MockCognitionBackend implements CognitionBackend {
  private decisions: Map<string, DecisionResponse> = new Map();
  private defaultDecision: DecisionResponse = { action: "idle", reasoning: "mock default" };
  public decideCalls: DecisionRequest[] = [];
  public interviewCalls: Array<{ context: string; question: string }> = [];

  async start(): Promise<void> {}
  async shutdown(): Promise<void> {}

  /**
   * Register a canned decision for an actor name.
   */
  setDecision(actorName: string, decision: DecisionResponse): void {
    this.decisions.set(actorName, decision);
  }

  setDefault(decision: DecisionResponse): void {
    this.defaultDecision = decision;
  }

  async decide(request: DecisionRequest): Promise<DecisionResponse> {
    this.decideCalls.push(request);
    return this.decisions.get(request.actor.name) ?? this.defaultDecision;
  }

  async interview(actorContext: string, question: string): Promise<string> {
    this.interviewCalls.push({ context: actorContext, question });
    return `Mock interview response to: ${question}`;
  }
}

// ═══════════════════════════════════════════════════════
// buildSimContext — interaction summary for actor memory
// ═══════════════════════════════════════════════════════

/**
 * Build the simContext string for a DecisionRequest.
 * Derives temporal memory from normalized tables (no separate memory table).
 *
 * PLAN.md §Interaction Summary (lines 1245-1275):
 * "Actors need temporal memory — derived on-the-fly from existing
 *  normalized tables when building DecisionRequest.simContext"
 */
export function buildSimContext(
  actor: ActorRow,
  store: GraphStore,
  runId: string,
  roundNum: number,
  lookbackRounds: number = 5
): string {
  const sinceRound = Math.max(0, roundNum - lookbackRounds);

  // 1. Recent posts by this actor
  const myPosts = store.getRecentPostsByActor(actor.id, runId, sinceRound);

  // 2. Engagement on those posts
  const engagement = myPosts.length > 0
    ? store.getEngagementOnPosts(myPosts.map(p => p.id), runId)
    : new Map();

  // 3. Mentions/replies directed at this actor
  const mentions = store.getMentions(actor.id, runId, sinceRound);

  // 4. Stance changes in followed actors
  const stanceChanges = store.getFollowedStanceChanges(actor.id, runId, roundNum);

  // 5. Deliberative memories persisted from previous rounds
  const memories = store.getActorMemories(actor.id, runId, 3, 0.4);

  return formatInteractionSummary(myPosts, engagement, mentions, stanceChanges, memories);
}

/**
 * Format interaction data into a natural language summary.
 */
function formatInteractionSummary(
  myPosts: Array<{ id: string; content: string; likes: number; reposts: number; comments: number }>,
  engagement: Map<string, { likes: number; reposts: number; comments: number; reach: number }>,
  mentions: Array<{ author_id: string; content: string }>,
  stanceChanges: Array<{ actorName: string; previousStance: string; newStance: string }>,
  memories: Array<{ summary: string }>
): string {
  const parts: string[] = [];

  if (myPosts.length > 0) {
    const postSummaries = myPosts.slice(0, 3).map(p => {
      const eng = engagement.get(p.id);
      const stats = eng ? ` (${eng.likes} likes, ${eng.reposts} reposts)` : "";
      const snippet = p.content.length > 60 ? p.content.slice(0, 57) + "..." : p.content;
      return `"${snippet}"${stats}`;
    });
    parts.push(`Your recent posts: ${postSummaries.join("; ")}`);
  }

  if (mentions.length > 0) {
    const mentionSummaries = mentions.slice(0, 3).map(m => {
      const snippet = m.content.length > 50 ? m.content.slice(0, 47) + "..." : m.content;
      return `"${snippet}"`;
    });
    parts.push(`You were mentioned in: ${mentionSummaries.join("; ")}`);
  }

  if (stanceChanges.length > 0) {
    const changeSummaries = stanceChanges.slice(0, 3).map(
      sc => `${sc.actorName} shifted from ${sc.previousStance} to ${sc.newStance}`
    );
    parts.push(`Stance changes among followed: ${changeSummaries.join("; ")}`);
  }

  if (memories.length > 0) {
    const memorySummaries = memories.slice(0, 3).map((m) => m.summary);
    parts.push(`What you remember most: ${memorySummaries.join("; ")}`);
  }

  if (parts.length === 0) {
    return "No notable recent interactions.";
  }

  return `In recent rounds: ${parts.join(". ")}.`;
}

// ═══════════════════════════════════════════════════════
// Prompt Templates — decision prompts for DirectLLMBackend
// ═══════════════════════════════════════════════════════

const PROMPT_VERSION = "v1.0.0";

export function getPromptVersion(): string {
  return PROMPT_VERSION;
}

function buildDecisionSystemPrompt(request: DecisionRequest): string {
  const webContextSection = request.webContext
    ? `\nWEB CONTEXT:\n${request.webContext}\n`
    : "";

  return `You are simulating a social media user on X (formerly Twitter).

YOUR PERSONA:
Name: ${request.actor.name}
Personality: ${request.actor.personality}
Stance: ${request.actor.stance}
Language: ${request.actor.language}
${request.actor.gender ? `Gender: ${request.actor.gender}` : ""}
${request.actor.region ? `Region: ${request.actor.region}` : ""}
Topics of interest: ${request.actor.topics.join(", ")}

BELIEFS (topic → sentiment, -1.0 to 1.0):
${Object.entries(request.actor.belief_state).map(([t, s]) => `  ${t}: ${s.toFixed(1)}`).join("\n")}

INTERACTION CONTEXT:
${request.simContext}
${webContextSection}

You must decide what to do next. Choose ONE action from the available actions.
Respond with valid JSON only.`;
}

function buildDecisionUserPrompt(request: DecisionRequest): string {
  const feedText = request.feed.length > 0
    ? request.feed.slice(0, 10).map((item, i) => {
        const p = item.post;
        return `${i + 1}. [${item.source}] @${p.authorId}: "${p.content.slice(0, 100)}" ` +
               `(${p.likes}♡ ${p.reposts}↻ ${p.comments}💬, sentiment=${p.sentiment.toFixed(1)})`;
      }).join("\n")
    : "(empty feed)";

  return `YOUR FEED:\n${feedText}\n\n` +
    `AVAILABLE ACTIONS: ${request.availableActions.join(", ")}\n\n` +
    `Choose your action. Respond as JSON:\n` +
    `{\n` +
    `  "action": "post|comment|repost|like|follow|idle",\n` +
    `  "content": "text of post/comment (if action=post or comment)",\n` +
    `  "target": "post_id or user_id (if action=comment/repost/like/follow)",\n` +
    `  "reasoning": "brief explanation of why you chose this action"\n` +
    `}`;
}

// ═══════════════════════════════════════════════════════
// Validation
// ═══════════════════════════════════════════════════════

const VALID_ACTIONS = new Set(["post", "comment", "repost", "like", "follow", "search", "idle"]);

function validateDecisionResponse(data: unknown): DecisionResponse {
  const obj = data as Record<string, unknown>;
  const action = String(obj.action ?? "idle");

  if (!VALID_ACTIONS.has(action)) {
    return { action: "idle", reasoning: `Invalid action "${action}", defaulting to idle` };
  }

  return {
    action: action as DecisionResponse["action"],
    content: typeof obj.content === "string" ? obj.content : undefined,
    target: typeof obj.target === "string" ? obj.target : undefined,
    reasoning: typeof obj.reasoning === "string" ? obj.reasoning : undefined,
  };
}

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function parseJsonArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/**
 * Build a DecisionRequest from actor data and simulation state.
 * Convenience function for engine.ts.
 */
export function buildDecisionRequest(
  actor: ActorRow,
  feed: FeedItem[],
  beliefs: Record<string, number>,
  topics: string[],
  simContext: string,
  roundNum: number = 0,
  webContext?: string
): DecisionRequest {
  return {
    actorId: actor.id,
    roundNum,
    actor: {
      name: actor.name,
      personality: actor.personality,
      stance: actor.stance,
      gender: actor.gender ?? undefined,
      region: actor.region ?? undefined,
      language: actor.language,
      topics,
      belief_state: beliefs,
    },
    feed,
    availableActions: ["post", "comment", "repost", "like", "follow", "idle"],
    platform: "x",
    simContext,
    webContext,
  };
}
