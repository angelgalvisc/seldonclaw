/**
 * index.test.ts — Tests for CLI stats command output formatting
 *
 * Tests the stats query logic directly (not subprocess-based)
 * since the CLI is thin Commander wrapper around engine + store.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SQLiteGraphStore } from "../src/db.js";
import type { ActorRow } from "../src/db.js";
import { getTierStats } from "../src/telemetry.js";
import { updateRound } from "../src/telemetry.js";

let store: SQLiteGraphStore;

function makeActor(overrides: Partial<ActorRow> = {}): ActorRow {
  return {
    id: "actor-1",
    run_id: "run-1",
    entity_id: null,
    archetype: "persona",
    cognition_tier: "B",
    name: "Test Actor",
    handle: "@test",
    personality: "A test persona",
    bio: null,
    age: 25,
    gender: "male",
    profession: null,
    region: null,
    language: "es",
    stance: "neutral",
    sentiment_bias: 0.0,
    activity_level: 0.5,
    influence_weight: 0.5,
    community_id: null,
    active_hours: null,
    follower_count: 50,
    following_count: 30,
    ...overrides,
  };
}

beforeEach(() => {
  store = new SQLiteGraphStore(":memory:");
  store.createRun({
    id: "run-1",
    started_at: "2024-01-01T00:00:00",
    seed: 42,
    config_snapshot: "{}",
    graph_revision_id: "rev-1",
    status: "completed",
    total_rounds: 5,
  });
});

afterEach(() => {
  store.close();
});

// ═══════════════════════════════════════════════════════
// STATS QUERIES
// ═══════════════════════════════════════════════════════

describe("stats queries", () => {
  it("tier stats reflect actor tiers", () => {
    store.addActor(makeActor({ id: "a1", cognition_tier: "A" }));
    store.addActor(makeActor({ id: "a2", cognition_tier: "A" }));
    store.addActor(makeActor({ id: "a3", cognition_tier: "B" }));
    store.addActor(makeActor({ id: "a4", cognition_tier: "C" }));
    store.addActor(makeActor({ id: "a5", cognition_tier: "C" }));
    store.addActor(makeActor({ id: "a6", cognition_tier: "C" }));

    const stats = getTierStats(store, "run-1");
    expect(stats.tierA).toBe(2);
    expect(stats.tierB).toBe(1);
    expect(stats.tierC).toBe(3);
  });

  it("round aggregates sum correctly", () => {
    updateRound(store, { num: 0, runId: "run-1", totalPosts: 5, totalActions: 10, tierACalls: 2, tierBCalls: 3, tierCActions: 5 });
    updateRound(store, { num: 1, runId: "run-1", totalPosts: 8, totalActions: 15, tierACalls: 3, tierBCalls: 4, tierCActions: 8 });

    const sums = (store as any).db
      .prepare(
        `SELECT SUM(total_posts) as posts, SUM(total_actions) as actions,
                SUM(tier_a_calls) as a, SUM(tier_b_calls) as b, SUM(tier_c_actions) as c
         FROM rounds WHERE run_id = ?`
      )
      .get("run-1") as { posts: number; actions: number; a: number; b: number; c: number };

    expect(sums.posts).toBe(13);
    expect(sums.actions).toBe(25);
    expect(sums.a).toBe(5);
    expect(sums.b).toBe(7);
    expect(sums.c).toBe(13);
  });

  it("run manifest stores completion info", () => {
    const run = store.getRun("run-1");
    expect(run).not.toBeNull();
    expect(run!.status).toBe("completed");
    expect(run!.seed).toBe(42);
    expect(run!.total_rounds).toBe(5);
  });

  it("handles missing run gracefully", () => {
    const run = store.getRun("nonexistent");
    expect(run).toBeNull();
  });

  it("empty run has zero stats", () => {
    const stats = getTierStats(store, "run-1");
    expect(stats).toEqual({ tierA: 0, tierB: 0, tierC: 0 });
  });
});
