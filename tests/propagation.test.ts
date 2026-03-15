/**
 * propagation.test.ts — Tests for within/cross-community post spread
 *
 * Covers:
 * - Influential author → more within-community exposures
 * - Already-exposed actors are skipped
 * - Cross-community spread via overlaps
 * - Zero overlap → no cross-community spread
 * - Viral threshold detection
 * - Determinism (same seed → same result)
 * - Empty communities → no crash
 * - Reach deltas accumulate correctly
 * - Probability clamp (high values stay ≤ 1.0)
 */

import { describe, it, expect } from "vitest";
import { propagate } from "../src/propagation.js";
import type {
  PlatformState,
  PostSnapshot,
  ActorSnapshot,
  CommunitySnapshot,
  EngagementStats,
} from "../src/db.js";
import type { PropagationConfig } from "../src/config.js";
import { SeedablePRNG } from "../src/reproducibility.js";

// ═══════════════════════════════════════════════════════
// FIXTURES
// ═══════════════════════════════════════════════════════

const defaultConfig: PropagationConfig = {
  viralThreshold: 30,
  crossCommunityDecay: 0.7,
  influenceMultiplier: 1.5,
};

function makePost(overrides: Partial<PostSnapshot> = {}): PostSnapshot {
  return {
    id: "post-1",
    authorId: "actor-1",
    content: "Test post",
    roundNum: 0,
    simTimestamp: "2024-01-01T00:00:00",
    topics: ["education"],
    sentiment: -0.5,
    likes: 5,
    reposts: 2,
    comments: 3,
    reach: 10,
    ...overrides,
  };
}

function makeActor(overrides: Partial<ActorSnapshot> = {}): ActorSnapshot {
  return {
    id: "actor-1",
    communityId: "comm-1",
    influenceWeight: 0.8,
    stance: "neutral",
    sentimentBias: 0.0,
    ...overrides,
  };
}

function makeCommunity(overrides: Partial<CommunitySnapshot> = {}): CommunitySnapshot {
  return {
    id: "comm-1",
    cohesion: 0.7,
    memberIds: ["actor-1", "actor-2", "actor-3", "actor-4", "actor-5"],
    overlaps: new Map(),
    ...overrides,
  };
}

function makeState(overrides: Partial<PlatformState> = {}): PlatformState {
  const actors = new Map<string, ActorSnapshot>();
  actors.set("actor-1", makeActor());

  return {
    runId: "run-1",
    recentPosts: [makePost()],
    followGraph: new Map(),
    engagementByPost: new Map(),
    actors,
    communities: [makeCommunity()],
    exposedActors: new Map(),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════
// WITHIN-COMMUNITY SPREAD
// ═══════════════════════════════════════════════════════

describe("propagate — within-community", () => {
  it("creates exposures for community members", () => {
    const state = makeState();
    const result = propagate(state, defaultConfig, 1, new SeedablePRNG(42));

    // Should create some exposures for members actor-2 through actor-5
    expect(result.newExposures.length).toBeGreaterThan(0);
    // Author (actor-1) should not be exposed to own post
    expect(result.newExposures.every((e) => e.actor_id !== "actor-1")).toBe(true);
    // All exposures are "seen"
    expect(result.newExposures.every((e) => e.reaction === "seen")).toBe(true);
  });

  it("influential author produces more exposures", () => {
    let highInfluenceCount = 0;
    let lowInfluenceCount = 0;

    for (let seed = 0; seed < 30; seed++) {
      const highActors = new Map<string, ActorSnapshot>();
      highActors.set("actor-1", makeActor({ influenceWeight: 0.95 }));
      const highState = makeState({ actors: highActors });
      const highResult = propagate(highState, defaultConfig, 1, new SeedablePRNG(seed));
      highInfluenceCount += highResult.newExposures.length;

      const lowActors = new Map<string, ActorSnapshot>();
      lowActors.set("actor-1", makeActor({ influenceWeight: 0.1 }));
      const lowState = makeState({ actors: lowActors });
      const lowResult = propagate(lowState, defaultConfig, 1, new SeedablePRNG(seed));
      lowInfluenceCount += lowResult.newExposures.length;
    }

    expect(highInfluenceCount).toBeGreaterThan(lowInfluenceCount);
  });

  it("skips already-exposed actors", () => {
    const exposed = new Map<string, Set<string>>();
    exposed.set("post-1", new Set(["actor-2", "actor-3"]));

    const state = makeState({ exposedActors: exposed });
    const result = propagate(state, defaultConfig, 1, new SeedablePRNG(42));

    // actor-2 and actor-3 should not appear in new exposures
    const exposedIds = result.newExposures.map((e) => e.actor_id);
    expect(exposedIds).not.toContain("actor-2");
    expect(exposedIds).not.toContain("actor-3");
  });

  it("no duplicate exposures within same propagation round", () => {
    const state = makeState();
    const result = propagate(state, defaultConfig, 1, new SeedablePRNG(42));

    const seen = new Set<string>();
    for (const e of result.newExposures) {
      const key = `${e.post_id}:${e.actor_id}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

// ═══════════════════════════════════════════════════════
// CROSS-COMMUNITY SPREAD
// ═══════════════════════════════════════════════════════

describe("propagate — cross-community", () => {
  it("spreads to other community via overlaps", () => {
    const comm1 = makeCommunity({
      id: "comm-1",
      memberIds: ["actor-1", "actor-2"],
      overlaps: new Map([["comm-2", 0.8]]),
    });
    const comm2 = makeCommunity({
      id: "comm-2",
      memberIds: ["actor-3", "actor-4", "actor-5"],
      overlaps: new Map([["comm-1", 0.8]]),
    });

    // Post with high engagement to boost virality
    const post = makePost({ likes: 20, reposts: 10, comments: 5 });

    const actors = new Map<string, ActorSnapshot>();
    actors.set("actor-1", makeActor({ influenceWeight: 0.9 }));

    const state = makeState({
      recentPosts: [post],
      actors,
      communities: [comm1, comm2],
    });

    let crossExposures = 0;
    for (let seed = 0; seed < 30; seed++) {
      const result = propagate(state, defaultConfig, 1, new SeedablePRNG(seed));
      const crossCommunity = result.newExposures.filter(
        (e) => ["actor-3", "actor-4", "actor-5"].includes(e.actor_id)
      );
      crossExposures += crossCommunity.length;
    }

    expect(crossExposures).toBeGreaterThan(0);
  });

  it("zero overlap → no cross-community spread", () => {
    const comm1 = makeCommunity({
      id: "comm-1",
      memberIds: ["actor-1", "actor-2"],
      overlaps: new Map(), // no overlaps
    });
    const comm2 = makeCommunity({
      id: "comm-2",
      memberIds: ["actor-3", "actor-4"],
      overlaps: new Map(),
    });

    const actors = new Map<string, ActorSnapshot>();
    actors.set("actor-1", makeActor());

    const state = makeState({
      actors,
      communities: [comm1, comm2],
    });

    const result = propagate(state, defaultConfig, 1, new SeedablePRNG(42));
    const crossExposures = result.newExposures.filter(
      (e) => ["actor-3", "actor-4"].includes(e.actor_id)
    );
    expect(crossExposures).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════
// VIRAL DETECTION
// ═══════════════════════════════════════════════════════

describe("propagate — viral detection", () => {
  it("detects viral posts exceeding threshold", () => {
    // Post with reach=25, needs 6+ new reach to exceed threshold of 30
    const post = makePost({ reach: 25 });

    const bigCommunity = makeCommunity({
      memberIds: Array.from({ length: 20 }, (_, i) => `actor-${i}`),
      cohesion: 0.9,
    });

    const actors = new Map<string, ActorSnapshot>();
    actors.set("actor-0", makeActor({ id: "actor-0", influenceWeight: 0.95 }));
    // Author is actor-0 in the post
    const viralPost = makePost({ ...post, authorId: "actor-0", reach: 25 });

    const state = makeState({
      recentPosts: [viralPost],
      actors,
      communities: [bigCommunity],
    });

    // With high influence and cohesion, should get enough exposures
    let foundViral = false;
    for (let seed = 0; seed < 50; seed++) {
      const result = propagate(state, defaultConfig, 1, new SeedablePRNG(seed));
      if (result.viralPosts.length > 0) {
        foundViral = true;
        break;
      }
    }
    expect(foundViral).toBe(true);
  });

  it("does not flag low-reach posts as viral", () => {
    const post = makePost({ reach: 0 });
    const state = makeState({
      recentPosts: [post],
      communities: [makeCommunity({ memberIds: ["actor-1", "actor-2"] })],
    });

    const result = propagate(state, defaultConfig, 1, new SeedablePRNG(42));
    expect(result.viralPosts).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════
// DETERMINISM & EDGE CASES
// ═══════════════════════════════════════════════════════

describe("propagate — determinism", () => {
  it("same seed → same result", () => {
    const state = makeState();
    const r1 = propagate(state, defaultConfig, 1, new SeedablePRNG(42));
    const r2 = propagate(state, defaultConfig, 1, new SeedablePRNG(42));

    expect(r1.newExposures.length).toBe(r2.newExposures.length);
    expect(r1.newExposures.map((e) => e.actor_id)).toEqual(
      r2.newExposures.map((e) => e.actor_id)
    );
  });

  it("different seed may produce different result", () => {
    const bigCommunity = makeCommunity({
      memberIds: Array.from({ length: 20 }, (_, i) => `actor-${i}`),
    });
    const actors = new Map<string, ActorSnapshot>();
    actors.set("actor-0", makeActor({ id: "actor-0" }));

    const state = makeState({
      recentPosts: [makePost({ authorId: "actor-0" })],
      actors,
      communities: [bigCommunity],
    });

    const r1 = propagate(state, defaultConfig, 1, new SeedablePRNG(42));
    const r2 = propagate(state, defaultConfig, 1, new SeedablePRNG(99));

    // With 19 candidates at ~0.84 prob, likely same but possible to differ
    // Just check both produce results
    expect(r1.newExposures.length).toBeGreaterThan(0);
    expect(r2.newExposures.length).toBeGreaterThan(0);
  });
});

describe("propagate — edge cases", () => {
  it("empty communities → no crash, no exposures", () => {
    const state = makeState({ communities: [] });
    const result = propagate(state, defaultConfig, 1, new SeedablePRNG(42));
    expect(result.newExposures).toHaveLength(0);
    expect(result.viralPosts).toHaveLength(0);
  });

  it("no posts → empty result", () => {
    const state = makeState({ recentPosts: [] });
    const result = propagate(state, defaultConfig, 1, new SeedablePRNG(42));
    expect(result.newExposures).toHaveLength(0);
  });

  it("author not in actors map → post skipped", () => {
    const state = makeState({ actors: new Map() });
    const result = propagate(state, defaultConfig, 1, new SeedablePRNG(42));
    expect(result.newExposures).toHaveLength(0);
  });

  it("reach deltas accumulate correctly", () => {
    const state = makeState();
    const result = propagate(state, defaultConfig, 1, new SeedablePRNG(42));

    if (result.newExposures.length > 0) {
      const delta = result.reachDeltas.get("post-1") ?? 0;
      expect(delta).toBe(result.newExposures.length);
    }
  });

  it("probability clamp: extreme values stay ≤ 1.0", () => {
    // influenceWeight=1.0 × cohesion=1.0 × influenceMultiplier=1.5 = 1.5 → clamped to 1.0
    const actors = new Map<string, ActorSnapshot>();
    actors.set("actor-1", makeActor({ influenceWeight: 1.0 }));

    const community = makeCommunity({
      cohesion: 1.0,
      memberIds: ["actor-1", "actor-2"],
    });

    const state = makeState({ actors, communities: [community] });
    // Should not crash and actor-2 should always be exposed (prob = 1.0)
    let exposed = 0;
    for (let seed = 0; seed < 20; seed++) {
      const result = propagate(state, defaultConfig, 1, new SeedablePRNG(seed));
      if (result.newExposures.some((e) => e.actor_id === "actor-2")) exposed++;
    }
    expect(exposed).toBe(20); // always exposed at clamp(1.5) = 1.0
  });
});
