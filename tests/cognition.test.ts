/**
 * cognition.test.ts — Tests for CognitionRouter, DecisionPolicy, CognitionBackend
 *
 * Covers:
 * - routeCognition: tier A (high influence), tier A (archetype override)
 * - routeCognition: tier B (random sampling), tier B (event mention)
 * - routeCognition: tier C (default)
 * - applyTierCRules: viral repost, aligned like, idle
 * - MockCognitionBackend: decide/interview
 * - buildDecisionRequest: correct structure
 * - buildSimContext: formats interaction summary
 * - validateDecisionResponse: valid and invalid actions
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SQLiteGraphStore } from "../src/db.js";
import type { ActorRow, FeedItem, PostSnapshot, SimEvent } from "../src/db.js";
import { SeedablePRNG } from "../src/reproducibility.js";
import {
  routeCognition,
  applyTierCRules,
  MockCognitionBackend,
  buildDecisionRequest,
  buildSimContext,
  getPromptVersion,
} from "../src/cognition.js";
import type { CognitionConfig } from "../src/config.js";

// ═══════════════════════════════════════════════════════
// TEST FIXTURES
// ═══════════════════════════════════════════════════════

const defaultCognitionConfig: CognitionConfig = {
  tierA: {
    minInfluence: 0.8,
    archetypeOverrides: ["institution", "media"],
  },
  tierB: {
    samplingRate: 0.3,
  },
  tierC: {
    repostProb: 0.4,
    likeProb: 0.6,
  },
  interactionLookback: 5,
};

function makeActor(overrides: Partial<ActorRow> = {}): ActorRow {
  return {
    id: "actor-1",
    run_id: "run-1",
    entity_id: "entity-1",
    archetype: "persona",
    cognition_tier: "B",
    name: "Test Actor",
    handle: "@test",
    personality: "A test persona",
    bio: "Test bio",
    age: 25,
    gender: "male",
    profession: "Student",
    region: "Bogotá",
    language: "es",
    stance: "neutral",
    sentiment_bias: 0.0,
    activity_level: 0.5,
    influence_weight: 0.5,
    community_id: "comm-1",
    active_hours: JSON.stringify([8, 9, 10, 20, 21]),
    follower_count: 50,
    following_count: 30,
    ...overrides,
  };
}

function makePost(overrides: Partial<PostSnapshot> = {}): PostSnapshot {
  return {
    id: "post-1",
    authorId: "actor-2",
    content: "Test post about education policy changes",
    roundNum: 5,
    simTimestamp: "2024-01-01T10:00:00",
    topics: ["education"],
    sentiment: 0.3,
    likes: 10,
    reposts: 3,
    comments: 2,
    reach: 50,
    ...overrides,
  };
}

function makeFeedItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    post: makePost(),
    score: 0.8,
    source: "follow",
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════
// CognitionRouter
// ═══════════════════════════════════════════════════════

describe("routeCognition", () => {
  it("routes high-influence actor to tier A", () => {
    const actor = makeActor({ influence_weight: 0.9 });
    const rng = new SeedablePRNG(42);
    const result = routeCognition(actor, [], defaultCognitionConfig, rng);
    expect(result.tier).toBe("A");
    expect(result.reason).toContain("influence");
  });

  it("routes archetype override to tier A", () => {
    const actor = makeActor({ archetype: "media", influence_weight: 0.3 });
    const rng = new SeedablePRNG(42);
    const result = routeCognition(actor, [], defaultCognitionConfig, rng);
    expect(result.tier).toBe("A");
    expect(result.reason).toContain("archetype");
  });

  it("routes institution archetype to tier A", () => {
    const actor = makeActor({ archetype: "institution", influence_weight: 0.2 });
    const rng = new SeedablePRNG(42);
    const result = routeCognition(actor, [], defaultCognitionConfig, rng);
    expect(result.tier).toBe("A");
    expect(result.reason).toContain("archetype");
  });

  it("routes actor mentioned in event to tier B", () => {
    const actor = makeActor({ influence_weight: 0.3 });
    const events: SimEvent[] = [{
      type: "threshold_trigger",
      round: 5,
      actor_id: "actor-1",
      content: "University responds",
      topics: ["education"],
    }];
    const rng = new SeedablePRNG(42);
    const result = routeCognition(actor, [], defaultCognitionConfig, rng, events);
    expect(result.tier).toBe("B");
    expect(result.reason).toContain("event");
  });

  it("routes actor with overlapping event topics to tier B", () => {
    const actor = makeActor({ influence_weight: 0.3 });
    const events: SimEvent[] = [{
      type: "threshold_trigger",
      round: 5,
      content: "Education policy debate heats up",
      topics: ["education", "policy"],
    }];
    const rng = new SeedablePRNG(42);
    // Actor topics overlap with event topics ("education")
    const result = routeCognition(actor, [], defaultCognitionConfig, rng, events, ["education", "protest"]);
    expect(result.tier).toBe("B");
    expect(result.reason).toContain("event");
  });

  it("does not promote to tier B when event topics don't overlap actor topics", () => {
    const actor = makeActor({ influence_weight: 0.3 });
    const events: SimEvent[] = [{
      type: "threshold_trigger",
      round: 5,
      content: "Sports news update",
      topics: ["sports"],
    }];
    const config: CognitionConfig = {
      ...defaultCognitionConfig,
      tierB: { samplingRate: 0.0 }, // disable random sampling
    };
    const rng = new SeedablePRNG(42);
    // Actor topics don't overlap with event topics
    const result = routeCognition(actor, [], config, rng, events, ["education", "protest"]);
    expect(result.tier).toBe("C");
  });

  it("routes low-influence actor to tier C (deterministic)", () => {
    // Use a seed where sampling doesn't fire
    const actor = makeActor({ influence_weight: 0.1 });
    const config: CognitionConfig = {
      ...defaultCognitionConfig,
      tierB: { samplingRate: 0.0 }, // 0% sampling → always C
    };
    const rng = new SeedablePRNG(42);
    const result = routeCognition(actor, [], config, rng);
    expect(result.tier).toBe("C");
    expect(result.reason).toContain("default");
  });

  it("same seed produces same routing", () => {
    const actor = makeActor({ influence_weight: 0.4 });

    const results: string[] = [];
    for (let i = 0; i < 5; i++) {
      const rng = new SeedablePRNG(42);
      results.push(routeCognition(actor, [], defaultCognitionConfig, rng).tier);
    }

    // All should be the same since same seed
    expect(new Set(results).size).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════
// DecisionPolicy (Tier C)
// ═══════════════════════════════════════════════════════

describe("applyTierCRules", () => {
  it("returns idle when feed is empty", () => {
    const actor = makeActor();
    const rng = new SeedablePRNG(42);
    const result = applyTierCRules(actor, [], defaultCognitionConfig, rng);
    expect(result.action).toBe("idle");
    expect(result.reasoning).toContain("tier-C");
  });

  it("reposts viral content with configured probability", () => {
    const actor = makeActor({ sentiment_bias: 0.5 });
    const feed = [makeFeedItem({
      post: makePost({ likes: 100, reposts: 50 }),
      score: 0.9,
    })];

    // Run multiple times with deterministic seeds to verify behavior
    let repostCount = 0;
    for (let seed = 0; seed < 100; seed++) {
      const rng = new SeedablePRNG(seed);
      const result = applyTierCRules(actor, feed, defaultCognitionConfig, rng);
      if (result.action === "repost") repostCount++;
    }

    // With repostProb=0.4, should see roughly 40% reposts
    expect(repostCount).toBeGreaterThan(20);
    expect(repostCount).toBeLessThan(60);
  });

  it("likes aligned posts from follows", () => {
    const actor = makeActor({ sentiment_bias: 0.5 });
    const feed = [makeFeedItem({
      post: makePost({ sentiment: 0.7, likes: 2, reposts: 1 }), // not viral
      score: 0.5,
      source: "follow",
    })];

    let likeCount = 0;
    for (let seed = 0; seed < 100; seed++) {
      const rng = new SeedablePRNG(seed);
      const result = applyTierCRules(actor, feed, defaultCognitionConfig, rng);
      if (result.action === "like") likeCount++;
    }

    // With likeProb=0.6, should see roughly 60% likes
    expect(likeCount).toBeGreaterThan(35);
    expect(likeCount).toBeLessThan(80);
  });

  it("deterministic: same seed → same decision", () => {
    const actor = makeActor({ sentiment_bias: 0.5 });
    const feed = [makeFeedItem({
      post: makePost({ likes: 100, reposts: 50 }),
      score: 0.9,
    })];

    const rng1 = new SeedablePRNG(42);
    const rng2 = new SeedablePRNG(42);

    const result1 = applyTierCRules(actor, feed, defaultCognitionConfig, rng1);
    const result2 = applyTierCRules(actor, feed, defaultCognitionConfig, rng2);

    expect(result1).toEqual(result2);
  });

  it("does not like non-aligned posts", () => {
    const actor = makeActor({ sentiment_bias: 0.8 }); // positive
    const feed = [makeFeedItem({
      post: makePost({ sentiment: -0.7, likes: 2, reposts: 1 }), // negative
      score: 0.5,
      source: "follow",
    })];

    let likeCount = 0;
    for (let seed = 0; seed < 50; seed++) {
      const rng = new SeedablePRNG(seed);
      const result = applyTierCRules(actor, feed, defaultCognitionConfig, rng);
      if (result.action === "like") likeCount++;
    }

    // Non-aligned → should never like (sentiment_bias > 0 but post sentiment < 0)
    expect(likeCount).toBe(0);
  });

  it("respects available actions for tier C", () => {
    const actor = makeActor({ sentiment_bias: 0.5 });
    const feed = [makeFeedItem({
      post: makePost({ likes: 100, reposts: 50 }),
      score: 0.9,
    })];

    const result = applyTierCRules(
      actor,
      feed,
      defaultCognitionConfig,
      new SeedablePRNG(42),
      ["idle"]
    );

    expect(result.action).toBe("idle");
  });
});

// ═══════════════════════════════════════════════════════
// MockCognitionBackend
// ═══════════════════════════════════════════════════════

describe("MockCognitionBackend", () => {
  it("returns default decision", async () => {
    const backend = new MockCognitionBackend();
    await backend.start();

    const request = buildDecisionRequest(
      makeActor(),
      [],
      { education: -0.5 },
      ["education"],
      "No interactions."
    );

    const result = await backend.decide(request);
    expect(result.action).toBe("idle"); // default
  });

  it("returns registered decision for actor", async () => {
    const backend = new MockCognitionBackend();
    backend.setDecision("Key Actor", { action: "post", content: "Important opinion", reasoning: "test" });

    const request = buildDecisionRequest(
      makeActor({ name: "Key Actor" }),
      [],
      {},
      [],
      ""
    );

    const result = await backend.decide(request);
    expect(result.action).toBe("post");
    expect(result.content).toBe("Important opinion");
  });

  it("tracks decide calls", async () => {
    const backend = new MockCognitionBackend();
    const request = buildDecisionRequest(makeActor(), [], {}, [], "");

    await backend.decide(request);
    await backend.decide(request);

    expect(backend.decideCalls).toHaveLength(2);
  });

  it("returns mock interview response", async () => {
    const backend = new MockCognitionBackend();
    const result = await backend.interview("Actor context", "What do you think?");
    expect(result).toContain("What do you think?");
  });

  it("tracks interview calls", async () => {
    const backend = new MockCognitionBackend();
    await backend.interview("context", "question");
    expect(backend.interviewCalls).toHaveLength(1);
    expect(backend.interviewCalls[0]).toEqual({ context: "context", question: "question" });
  });
});

// ═══════════════════════════════════════════════════════
// buildDecisionRequest
// ═══════════════════════════════════════════════════════

describe("buildDecisionRequest", () => {
  it("builds correct structure from actor data", () => {
    const actor = makeActor({ name: "María García", language: "es", stance: "opposing" });
    const beliefs = { education: -0.8, protest: 0.6 };
    const topics = ["education", "protest"];

    const req = buildDecisionRequest(actor, [], beliefs, topics, "Recent context here.", 7);

    expect(req.actorId).toBe(actor.id);
    expect(req.roundNum).toBe(7);
    expect(req.actor.name).toBe("María García");
    expect(req.actor.language).toBe("es");
    expect(req.actor.stance).toBe("opposing");
    expect(req.actor.topics).toEqual(["education", "protest"]);
    expect(req.actor.belief_state).toEqual(beliefs);
    expect(req.platform).toBe("x");
    expect(req.simContext).toBe("Recent context here.");
    expect(req.availableActions).toContain("post");
    expect(req.availableActions).toContain("idle");
  });

  it("defaults roundNum to 0 when not specified", () => {
    const actor = makeActor();
    const req = buildDecisionRequest(actor, [], {}, [], "");
    expect(req.actorId).toBe("actor-1");
    expect(req.roundNum).toBe(0);
  });

  it("omits undefined optional fields", () => {
    const actor = makeActor({ gender: null, region: null });
    const req = buildDecisionRequest(actor, [], {}, [], "");
    expect(req.actor.gender).toBeUndefined();
    expect(req.actor.region).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════
// buildSimContext
// ═══════════════════════════════════════════════════════

describe("buildSimContext", () => {
  let store: SQLiteGraphStore;

  beforeEach(() => {
    store = new SQLiteGraphStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("returns default message when no interactions exist", () => {
    // Create run + actor
    store.createRun({
      id: "run-1",
      started_at: new Date().toISOString(),
      seed: 42,
      config_snapshot: "{}",
      graph_revision_id: "rev-1",
      status: "running",
    });

    const actor = makeActor({ entity_id: null });
    store.addActor(actor);

    const result = buildSimContext(actor, store, "run-1", 5);
    expect(result).toBe("No notable recent interactions.");
  });

  it("includes recent posts in summary", () => {
    store.createRun({
      id: "run-1",
      started_at: new Date().toISOString(),
      seed: 42,
      config_snapshot: "{}",
      graph_revision_id: "rev-1",
      status: "running",
    });

    const actor = makeActor({ entity_id: null });
    store.addActor(actor);

    // Add a post by this actor
    store.addPost({
      id: "post-1",
      run_id: "run-1",
      author_id: actor.id,
      content: "La educación pública debe ser accesible para todos",
      round_num: 3,
      sim_timestamp: "2024-01-01T10:00:00",
      likes: 15,
      reposts: 5,
      comments: 3,
      reach: 50,
    });

    const result = buildSimContext(actor, store, "run-1", 5);
    expect(result).toContain("recent posts");
    expect(result).toContain("educación");
  });
});

// ═══════════════════════════════════════════════════════
// Prompt version
// ═══════════════════════════════════════════════════════

describe("getPromptVersion", () => {
  it("returns a semver string", () => {
    const version = getPromptVersion();
    expect(version).toMatch(/^v\d+\.\d+\.\d+$/);
  });
});
