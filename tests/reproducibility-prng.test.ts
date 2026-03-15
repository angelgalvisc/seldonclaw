/**
 * reproducibility-prng.test.ts — Tests for PRNG, RecordedBackend, snapshots
 *
 * Covers:
 * - SeedablePRNG determinism (same seed → same sequence)
 * - SeedablePRNG distribution (values in [0, 1))
 * - SeedablePRNG state save/restore
 * - SeedablePRNG different seeds → different sequences
 * - RecordedBackend cache hit → returns cached decision
 * - RecordedBackend cache miss → throws error
 * - RecordedBackend different prompt_version → cache miss
 * - hashDecisionRequest stability
 * - Snapshot save/restore round-trip
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SQLiteGraphStore, stableId } from "../src/db.js";
import {
  SeedablePRNG,
  RecordedBackend,
  hashDecisionRequest,
  hashString,
  saveSnapshot,
  restoreSnapshot,
} from "../src/reproducibility.js";
import type { DecisionRequest, DecisionResponse } from "../src/cognition.js";

let store: SQLiteGraphStore;

beforeEach(() => {
  store = new SQLiteGraphStore(":memory:");
});

afterEach(() => {
  store.close();
});

// ═══════════════════════════════════════════════════════
// SeedablePRNG
// ═══════════════════════════════════════════════════════

describe("SeedablePRNG", () => {
  it("same seed produces identical sequence", () => {
    const a = new SeedablePRNG(42);
    const b = new SeedablePRNG(42);

    const seqA = Array.from({ length: 100 }, () => a.next());
    const seqB = Array.from({ length: 100 }, () => b.next());

    expect(seqA).toEqual(seqB);
  });

  it("different seeds produce different sequences", () => {
    const a = new SeedablePRNG(42);
    const b = new SeedablePRNG(99);

    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());

    expect(seqA).not.toEqual(seqB);
  });

  it("values are in [0, 1) range", () => {
    const prng = new SeedablePRNG(12345);
    for (let i = 0; i < 1000; i++) {
      const val = prng.next();
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
    }
  });

  it("nextInt returns integers in [min, max]", () => {
    const prng = new SeedablePRNG(42);
    for (let i = 0; i < 100; i++) {
      const val = prng.nextInt(1, 6);
      expect(Number.isInteger(val)).toBe(true);
      expect(val).toBeGreaterThanOrEqual(1);
      expect(val).toBeLessThanOrEqual(6);
    }
  });

  it("state save/restore continues identical sequence", () => {
    const prng = new SeedablePRNG(42);
    // Advance some steps
    for (let i = 0; i < 50; i++) prng.next();

    // Save state
    const savedState = prng.state();

    // Continue original
    const nextFromOriginal = Array.from({ length: 20 }, () => prng.next());

    // Restore and continue
    const restored = SeedablePRNG.fromState(savedState);
    const nextFromRestored = Array.from({ length: 20 }, () => restored.next());

    expect(nextFromRestored).toEqual(nextFromOriginal);
  });

  it("state serialization is valid JSON", () => {
    const prng = new SeedablePRNG(42);
    prng.next();
    const state = prng.state();
    expect(() => JSON.parse(state)).not.toThrow();
    const parsed = JSON.parse(state);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(4);
  });

  it("distribution is roughly uniform", () => {
    const prng = new SeedablePRNG(42);
    const buckets = [0, 0, 0, 0, 0]; // 5 buckets: [0,0.2), [0.2,0.4), etc.
    const N = 10000;

    for (let i = 0; i < N; i++) {
      const val = prng.next();
      const bucket = Math.min(4, Math.floor(val * 5));
      buckets[bucket]++;
    }

    // Each bucket should have roughly N/5 = 2000 values
    // Allow 15% deviation
    const expected = N / 5;
    for (const count of buckets) {
      expect(count).toBeGreaterThan(expected * 0.85);
      expect(count).toBeLessThan(expected * 1.15);
    }
  });
});

// ═══════════════════════════════════════════════════════
// Hashing
// ═══════════════════════════════════════════════════════

describe("hashDecisionRequest", () => {
  const makeRequest = (overrides: Partial<DecisionRequest> = {}): DecisionRequest => ({
    actorId: "actor-test",
    roundNum: 1,
    actor: {
      name: "test-actor",
      personality: "A passionate student leader",
      stance: "opposing",
      language: "es",
      topics: ["education", "protest"],
      belief_state: { education: -0.8, protest: 0.6 },
    },
    feed: [],
    availableActions: ["post", "comment", "like", "idle"],
    platform: "x",
    simContext: "No notable recent interactions.",
    ...overrides,
  });

  it("same request produces same hash", () => {
    const a = hashDecisionRequest(makeRequest());
    const b = hashDecisionRequest(makeRequest());
    expect(a).toBe(b);
  });

  it("different requests produce different hashes", () => {
    const a = hashDecisionRequest(makeRequest());
    const b = hashDecisionRequest(makeRequest({
      simContext: "Different context",
    }));
    expect(a).not.toBe(b);
  });

  it("webContext participates in the request hash", () => {
    const a = hashDecisionRequest(makeRequest());
    const b = hashDecisionRequest(
      makeRequest({
        webContext: "RECENT WEB INFORMATION (cutoff: 2026-03-01):\n1. News item",
      })
    );
    expect(a).not.toBe(b);
  });

  it("hash is a 64-char hex string (SHA-256)", () => {
    const hash = hashDecisionRequest(makeRequest());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("hashString", () => {
  it("same input → same hash", () => {
    expect(hashString("hello")).toBe(hashString("hello"));
  });

  it("different input → different hash", () => {
    expect(hashString("hello")).not.toBe(hashString("world"));
  });
});

// ═══════════════════════════════════════════════════════
// RecordedBackend
// ═══════════════════════════════════════════════════════

describe("RecordedBackend", () => {
  const modelId = "mock-model";
  const promptVersion = "v1.0.0";

  const sampleRequest: DecisionRequest = {
    actorId: "actor-test",
    roundNum: 1,
    actor: {
      name: "test-actor",
      personality: "A test persona",
      stance: "neutral",
      language: "es",
      topics: ["test"],
      belief_state: { test: 0 },
    },
    feed: [],
    availableActions: ["post", "idle"],
    platform: "x",
    simContext: "No interactions.",
  };

  const sampleDecision: DecisionResponse = {
    action: "post",
    content: "Test post content",
    reasoning: "Testing",
  };

  it("returns cached decision on hit", async () => {
    // Pre-populate cache
    const requestHash = hashDecisionRequest(sampleRequest);
    store.createRun({
      id: "run-1",
      started_at: new Date().toISOString(),
      seed: 42,
      config_snapshot: "{}",
      graph_revision_id: "rev-1",
      status: "running",
    });
    store.cacheDecision({
      id: "cache-1",
      run_id: "run-1",
      round_num: 1,
      actor_id: "test-actor",
      request_hash: requestHash,
      raw_response: JSON.stringify(sampleDecision),
      parsed_decision: JSON.stringify(sampleDecision),
      model_id: modelId,
      prompt_version: promptVersion,
    });

    const backend = new RecordedBackend(store, modelId, promptVersion);
    await backend.start();

    const result = await backend.decide(sampleRequest);
    expect(result).toEqual(sampleDecision);
  });

  it("throws on cache miss", async () => {
    const backend = new RecordedBackend(store, modelId, promptVersion);
    await backend.start();

    await expect(backend.decide(sampleRequest)).rejects.toThrow("cache miss");
  });

  it("different prompt_version → cache miss", async () => {
    // Cache with v1.0.0
    const requestHash = hashDecisionRequest(sampleRequest);
    store.createRun({
      id: "run-1",
      started_at: new Date().toISOString(),
      seed: 42,
      config_snapshot: "{}",
      graph_revision_id: "rev-1",
      status: "running",
    });
    store.cacheDecision({
      id: "cache-1",
      run_id: "run-1",
      round_num: 1,
      actor_id: "test-actor",
      request_hash: requestHash,
      raw_response: JSON.stringify(sampleDecision),
      parsed_decision: JSON.stringify(sampleDecision),
      model_id: modelId,
      prompt_version: "v1.0.0",
    });

    // Try to read with v2.0.0
    const backend = new RecordedBackend(store, modelId, "v2.0.0");
    await backend.start();

    await expect(backend.decide(sampleRequest)).rejects.toThrow("cache miss");
  });

  it("interview returns cached response", async () => {
    const context = "A student leader persona";
    const question = "What do you think about tuition?";
    const hash = hashString(`interview|${context}|${question}`);

    store.createRun({
      id: "run-1",
      started_at: new Date().toISOString(),
      seed: 42,
      config_snapshot: "{}",
      graph_revision_id: "rev-1",
      status: "running",
    });
    store.cacheDecision({
      id: "cache-int-1",
      run_id: "run-1",
      round_num: 1,
      actor_id: "interview",
      request_hash: hash,
      raw_response: "I strongly oppose the increase",
      parsed_decision: "{}",
      model_id: modelId,
      prompt_version: promptVersion,
    });

    const backend = new RecordedBackend(store, modelId, promptVersion);
    const result = await backend.interview(context, question);
    expect(result).toBe("I strongly oppose the increase");
  });
});

// ═══════════════════════════════════════════════════════
// Snapshots
// ═══════════════════════════════════════════════════════

describe("Snapshots", () => {
  it("save and restore round-trips correctly", () => {
    store.createRun({
      id: "run-1",
      started_at: new Date().toISOString(),
      seed: 42,
      config_snapshot: "{}",
      graph_revision_id: "rev-1",
      status: "running",
    });

    const prng = new SeedablePRNG(42);
    // Advance PRNG
    for (let i = 0; i < 10; i++) prng.next();

    const actorStates = [
      {
        id: "actor-1",
        stance: "opposing",
        sentiment_bias: -0.6,
        activity_level: 0.8,
        influence_weight: 0.9,
        follower_count: 100,
        following_count: 50,
      },
      {
        id: "actor-2",
        stance: "neutral",
        sentiment_bias: 0.1,
        activity_level: 0.5,
        influence_weight: 0.3,
        follower_count: 20,
        following_count: 30,
      },
    ];

    const narrativeStates = [
      {
        topic: "education",
        currentIntensity: 0.8,
        totalPosts: 42,
        dominantSentiment: -0.5,
        peakRound: 5,
      },
    ];

    saveSnapshot(store, "run-1", 10, actorStates, narrativeStates, prng);

    const restored = restoreSnapshot(store, "run-1");
    expect(restored).not.toBeNull();
    expect(restored!.roundNum).toBe(10);
    expect(Object.keys(restored!.actorStates)).toHaveLength(2);
    expect(restored!.actorStates["actor-1"].stance).toBe("opposing");
    expect(restored!.actorStates["actor-2"].sentiment_bias).toBe(0.1);
    expect(restored!.narrativeStates).toHaveLength(1);
    expect(restored!.narrativeStates[0].topic).toBe("education");
    expect(restored!.narrativeStates[0].totalPosts).toBe(42);
  });

  it("returns null when no snapshot exists", () => {
    const result = restoreSnapshot(store, "nonexistent-run");
    expect(result).toBeNull();
  });

  it("restores latest snapshot when multiple exist", () => {
    store.createRun({
      id: "run-1",
      started_at: new Date().toISOString(),
      seed: 42,
      config_snapshot: "{}",
      graph_revision_id: "rev-1",
      status: "running",
    });

    const prng1 = new SeedablePRNG(42);
    const prng2 = new SeedablePRNG(42);
    for (let i = 0; i < 20; i++) prng2.next();

    saveSnapshot(store, "run-1", 5, [], [{ topic: "old", currentIntensity: 0.3, totalPosts: 10, dominantSentiment: 0, peakRound: 3 }], prng1);
    saveSnapshot(store, "run-1", 10, [], [{ topic: "new", currentIntensity: 0.8, totalPosts: 42, dominantSentiment: -0.5, peakRound: 8 }], prng2);

    const restored = restoreSnapshot(store, "run-1");
    expect(restored!.roundNum).toBe(10);
    expect(restored!.narrativeStates[0].topic).toBe("new");
  });

  it("PRNG state in snapshot allows continuing sequence", () => {
    store.createRun({
      id: "run-1",
      started_at: new Date().toISOString(),
      seed: 42,
      config_snapshot: "{}",
      graph_revision_id: "rev-1",
      status: "running",
    });

    const prng = new SeedablePRNG(42);
    for (let i = 0; i < 25; i++) prng.next();

    // Save after 25 steps
    saveSnapshot(store, "run-1", 25, [], [], prng);

    // Continue original for 10 more
    const nextFromOriginal = Array.from({ length: 10 }, () => prng.next());

    // Restore and continue
    const restored = restoreSnapshot(store, "run-1");
    const restoredPRNG = SeedablePRNG.fromState(restored!.rngState);
    const nextFromRestored = Array.from({ length: 10 }, () => restoredPRNG.next());

    expect(nextFromRestored).toEqual(nextFromOriginal);
  });
});
