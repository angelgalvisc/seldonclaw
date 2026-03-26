/**
 * reproducibility.ts — Seedable PRNG, RecordedBackend, snapshots
 *
 * Source of truth: PLAN.md §RecordedBackend (lines 1200-1210),
 *                  §Reproducibility tables (lines 500-580)
 *
 * Provides:
 * - xoshiro128** PRNG (deterministic random from seed)
 * - RecordedBackend (replay decisions from decision_cache)
 * - Snapshot helpers (save/restore actor + narrative + rng state)
 */

import { createHash } from "node:crypto";
import type { PRNG as PRNGInterface, GraphStore } from "./db.js";
import type { CognitionBackend, DecisionRequest, DecisionResponse } from "./cognition.js";
import { MockLLMClient, type LLMClient } from "./llm.js";

// ═══════════════════════════════════════════════════════
// PRNG — xoshiro128** (32-bit, fast, good distribution)
// ═══════════════════════════════════════════════════════

/**
 * Seedable PRNG implementing xoshiro128**.
 * Deterministic: same seed → same sequence.
 * Implements the PRNG interface from db.ts.
 */
export class SeedablePRNG implements PRNGInterface {
  private s: Uint32Array;

  constructor(seed: number) {
    // Initialize state via splitmix32 (seed expansion)
    this.s = new Uint32Array(4);
    let z = (seed | 0) >>> 0;
    for (let i = 0; i < 4; i++) {
      z = (z + 0x9e3779b9) >>> 0;
      let t = z ^ (z >>> 16);
      t = Math.imul(t, 0x21f0aaad);
      t = t ^ (t >>> 15);
      t = Math.imul(t, 0x735a2d97);
      t = t ^ (t >>> 15);
      this.s[i] = t >>> 0;
    }
  }

  /**
   * Returns a random float in [0, 1).
   */
  next(): number {
    const result = this._nextU32();
    return (result >>> 0) / 0x100000000;
  }

  /**
   * Returns a random integer in [min, max] (inclusive).
   */
  nextInt(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /**
   * Serialize PRNG state for snapshot persistence.
   */
  state(): string {
    return JSON.stringify(Array.from(this.s));
  }

  /**
   * Restore PRNG from serialized state.
   */
  static fromState(stateStr: string): SeedablePRNG {
    const prng = Object.create(SeedablePRNG.prototype) as SeedablePRNG;
    const arr = JSON.parse(stateStr) as number[];
    prng.s = new Uint32Array(arr);
    return prng;
  }

  private _nextU32(): number {
    const s = this.s;
    const result = Math.imul(rotl(Math.imul(s[1], 5), 7), 9);
    const t = s[1] << 9;

    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);

    return result >>> 0;
  }
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

// ═══════════════════════════════════════════════════════
// RecordedBackend — replay from decision_cache
// ═══════════════════════════════════════════════════════

/**
 * CognitionBackend that replays decisions from the decision_cache table.
 * Used for exact reproduction of previous runs (0 LLM calls).
 *
 * Lookup key: (request_hash, model_id, prompt_version)
 * - request_hash covers actor context + feed (content-dependent)
 * - prompt_version prevents silent replay after prompt template changes
 */
export class RecordedBackend implements CognitionBackend {
  readonly llm: LLMClient = new MockLLMClient();

  constructor(
    private store: GraphStore,
    private modelId: string,
    private promptVersion: string
  ) {}

  async start(): Promise<void> {
    // No-op — no external process to start
  }

  async shutdown(): Promise<void> {
    // No-op — no external process to stop
  }

  async decide(request: DecisionRequest): Promise<DecisionResponse> {
    const hash = hashDecisionRequest(request);
    const cached = this.store.lookupDecision(hash, this.modelId, this.promptVersion);

    if (!cached) {
      throw new Error(
        `RecordedBackend: cache miss for request_hash=${hash}, ` +
        `model_id=${this.modelId}, prompt_version=${this.promptVersion}. ` +
        `No recorded decision available for replay.`
      );
    }

    return JSON.parse(cached.parsed_decision) as DecisionResponse;
  }

  async interview(actorContext: string, question: string): Promise<string> {
    // Interviews use the same cache with a synthetic request
    const hash = hashString(`interview|${actorContext}|${question}`);
    const cached = this.store.lookupDecision(hash, this.modelId, this.promptVersion);

    if (!cached) {
      throw new Error(
        `RecordedBackend: cache miss for interview hash=${hash}. ` +
        `No recorded interview available for replay.`
      );
    }

    return cached.raw_response;
  }
}

// ═══════════════════════════════════════════════════════
// HASHING — deterministic request hashing for cache keys
// ═══════════════════════════════════════════════════════

/**
 * Hash a DecisionRequest into a stable SHA-256 hex string.
 * Covers actor context + feed — the content-dependent parts.
 * Uses recursive key sorting for true canonical serialization.
 */
export function hashDecisionRequest(request: DecisionRequest): string {
  const canonical = canonicalStringify({
    actorId: request.actorId,
    actor: request.actor,
    feed: request.feed,
    availableActions: request.availableActions,
    platform: request.platform,
    simContext: request.simContext,
    webContext: request.webContext ?? null,
  });
  return hashString(canonical);
}

/**
 * JSON.stringify with recursively sorted keys.
 * Ensures identical objects with different key insertion order
 * produce the same string.
 */
function canonicalStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(v => canonicalStringify(v)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const pairs = sortedKeys.map(
    k => JSON.stringify(k) + ":" + canonicalStringify(obj[k])
  );
  return "{" + pairs.join(",") + "}";
}

/**
 * SHA-256 hash of an arbitrary string, returned as hex.
 */
export function hashString(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// ═══════════════════════════════════════════════════════
// SNAPSHOT — save/restore simulation state
// ═══════════════════════════════════════════════════════

export interface SnapshotData {
  roundNum: number;
  actorStates: Record<string, ActorStateSnapshot>;
  narrativeStates: NarrativeSnapshot[];
  firedTriggers: string[];
  rngState: string;
}

export interface ActorStateSnapshot {
  id: string;
  stance: string;
  sentiment_bias: number;
  activity_level: number;
  influence_weight: number;
  follower_count: number;
  following_count: number;
}

export interface NarrativeSnapshot {
  topic: string;
  currentIntensity: number;
  totalPosts: number;
  dominantSentiment: number;
  peakRound: number | null;
}

export interface SaveSnapshotInput {
  runId: string;
  roundNum: number;
  actorStates: ActorStateSnapshot[];
  narrativeStates: NarrativeSnapshot[];
  firedTriggers?: Set<string>;
  rng: SeedablePRNG;
}

/**
 * Save a snapshot of simulation state to the database.
 */
export function saveSnapshot(store: GraphStore, input: SaveSnapshotInput): void {
  const actorMap: Record<string, ActorStateSnapshot> = {};
  for (const a of input.actorStates) {
    actorMap[a.id] = a;
  }

  const id = createHash("sha256")
    .update(`${input.runId}|snapshot|${input.roundNum}`)
    .digest("hex")
    .slice(0, 32);

  store.saveSnapshot({
    id,
    run_id: input.runId,
    round_num: input.roundNum,
    actor_states: JSON.stringify(actorMap),
    narrative_states: JSON.stringify(input.narrativeStates),
    fired_triggers: JSON.stringify([...(input.firedTriggers ?? new Set<string>())]),
    rng_state: input.rng.state(),
  });
}

/**
 * Restore the latest snapshot for a run.
 * Returns null if no snapshot exists.
 */
export function restoreSnapshot(
  store: GraphStore,
  runId: string
): SnapshotData | null {
  const row = store.getLatestSnapshot(runId);
  if (!row) return null;

  return {
    roundNum: row.round_num,
    actorStates: JSON.parse(row.actor_states) as Record<string, ActorStateSnapshot>,
    narrativeStates: JSON.parse(row.narrative_states) as NarrativeSnapshot[],
    firedTriggers: JSON.parse(row.fired_triggers ?? "[]") as string[],
    rngState: row.rng_state,
  };
}
