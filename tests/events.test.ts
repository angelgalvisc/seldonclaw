/**
 * events.test.ts — Tests for event injection (initial, scheduled, threshold)
 *
 * Covers:
 * - Round 0 → initial posts emitted
 * - Scheduled event fires exactly at target round
 * - Threshold trigger: avgSentiment < -0.6
 * - Threshold trigger: postCount > 50
 * - Condition not met → no event
 * - Empty config → empty events
 * - Multiple triggers in same round
 * - Topic variable semantics (iterates all observed topics)
 * - Invalid condition string → no crash
 */

import { describe, it, expect } from "vitest";
import { processEvents, evaluateCondition } from "../src/events.js";
import type { PlatformState, PostSnapshot, ActorSnapshot, CommunitySnapshot } from "../src/db.js";
import type { EventConfig } from "../src/config.js";

// ═══════════════════════════════════════════════════════
// FIXTURES
// ═══════════════════════════════════════════════════════

function makePost(overrides: Partial<PostSnapshot> = {}): PostSnapshot {
  return {
    id: "post-1",
    authorId: "actor-1",
    content: "Test post",
    roundNum: 0,
    simTimestamp: "2024-01-01T00:00:00",
    topics: ["education"],
    sentiment: -0.5,
    likes: 0,
    reposts: 0,
    comments: 0,
    reach: 0,
    ...overrides,
  };
}

function makeState(overrides: Partial<PlatformState> = {}): PlatformState {
  return {
    runId: "run-1",
    recentPosts: [],
    followGraph: new Map(),
    engagementByPost: new Map(),
    actors: new Map(),
    communities: [],
    exposedActors: new Map(),
    ...overrides,
  };
}

const emptyConfig: EventConfig = {
  initialPosts: [],
  scheduled: [],
  thresholdTriggers: [],
};

// ═══════════════════════════════════════════════════════
// INITIAL POSTS
// ═══════════════════════════════════════════════════════

describe("processEvents — initial posts", () => {
  it("emits initial posts at round 0", () => {
    const config: EventConfig = {
      ...emptyConfig,
      initialPosts: [
        { content: "Breaking: tuition hike announced", topics: ["tuition"] },
        { content: "Campus protest starting", topics: ["protest", "campus"] },
      ],
    };

    const events = processEvents(0, config, makeState());
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("initial_post");
    expect(events[0].round).toBe(0);
    expect(events[0].content).toBe("Breaking: tuition hike announced");
    expect(events[0].topics).toEqual(["tuition"]);
    expect(events[1].topics).toEqual(["protest", "campus"]);
  });

  it("does not emit initial posts after round 0", () => {
    const config: EventConfig = {
      ...emptyConfig,
      initialPosts: [
        { content: "Breaking news", topics: ["tuition"] },
      ],
    };

    const events = processEvents(1, config, makeState());
    expect(events).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════
// SCHEDULED EVENTS
// ═══════════════════════════════════════════════════════

describe("processEvents — scheduled events", () => {
  it("fires exactly at target round", () => {
    const config: EventConfig = {
      ...emptyConfig,
      scheduled: [
        { round: 24, content: "Media coverage begins", topics: ["media"] },
      ],
    };

    expect(processEvents(23, config, makeState())).toHaveLength(0);
    expect(processEvents(24, config, makeState())).toHaveLength(1);
    expect(processEvents(25, config, makeState())).toHaveLength(0);

    const events = processEvents(24, config, makeState());
    expect(events[0].type).toBe("scheduled");
    expect(events[0].content).toBe("Media coverage begins");
  });

  it("multiple scheduled events at same round", () => {
    const config: EventConfig = {
      ...emptyConfig,
      scheduled: [
        { round: 10, content: "Event A", topics: ["a"] },
        { round: 10, content: "Event B", topics: ["b"] },
      ],
    };

    const events = processEvents(10, config, makeState());
    expect(events).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════
// THRESHOLD TRIGGERS
// ═══════════════════════════════════════════════════════

describe("processEvents — threshold triggers", () => {
  it("avgSentiment < -0.6 fires when condition met", () => {
    const posts = Array.from({ length: 10 }, (_, i) =>
      makePost({
        id: `post-${i}`,
        topics: ["tuition"],
        sentiment: -0.8,
      })
    );
    const state = makeState({ recentPosts: posts });

    const config: EventConfig = {
      ...emptyConfig,
      thresholdTriggers: [
        {
          condition: "avgSentiment(topic) < -0.6",
          event: "Institutional response",
          actorArchetype: "institution",
        },
      ],
    };

    const events = processEvents(5, config, state);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("threshold_trigger");
    expect(events[0].content).toBe("Institutional response");
    expect(events[0].topics).toContain("tuition");
  });

  it("postCount > 50 fires when condition met", () => {
    const posts = Array.from({ length: 55 }, (_, i) =>
      makePost({
        id: `post-${i}`,
        topics: ["protest"],
        sentiment: 0.0,
      })
    );
    const state = makeState({ recentPosts: posts });

    const config: EventConfig = {
      ...emptyConfig,
      thresholdTriggers: [
        {
          condition: "postCount(topic) > 50",
          event: "National media covers the situation",
          actorArchetype: "media",
        },
      ],
    };

    const events = processEvents(10, config, state);
    expect(events).toHaveLength(1);
    expect(events[0].topics).toContain("protest");
  });

  it("does not fire when condition not met", () => {
    const posts = [makePost({ topics: ["tuition"], sentiment: 0.2 })];
    const state = makeState({ recentPosts: posts });

    const config: EventConfig = {
      ...emptyConfig,
      thresholdTriggers: [
        {
          condition: "avgSentiment(topic) < -0.6",
          event: "Should not fire",
          actorArchetype: "institution",
        },
      ],
    };

    const events = processEvents(5, config, state);
    expect(events).toHaveLength(0);
  });

  it("returns only matching topics, not all topics", () => {
    const posts = [
      makePost({ id: "p1", topics: ["tuition"], sentiment: -0.9 }),
      makePost({ id: "p2", topics: ["campus"], sentiment: 0.5 }),
    ];
    const state = makeState({ recentPosts: posts });

    const config: EventConfig = {
      ...emptyConfig,
      thresholdTriggers: [
        {
          condition: "avgSentiment(topic) < -0.6",
          event: "Response",
          actorArchetype: "institution",
        },
      ],
    };

    const events = processEvents(5, config, state);
    expect(events).toHaveLength(1);
    expect(events[0].topics).toContain("tuition");
    expect(events[0].topics).not.toContain("campus");
  });
});

// ═══════════════════════════════════════════════════════
// EDGE CASES
// ═══════════════════════════════════════════════════════

describe("processEvents — edge cases", () => {
  it("empty config → empty events", () => {
    const events = processEvents(0, emptyConfig, makeState());
    expect(events).toHaveLength(0);
  });

  it("no posts → threshold triggers don't fire", () => {
    const config: EventConfig = {
      ...emptyConfig,
      thresholdTriggers: [
        {
          condition: "avgSentiment(topic) < -0.6",
          event: "Should not fire",
          actorArchetype: "institution",
        },
      ],
    };

    const events = processEvents(5, config, makeState());
    expect(events).toHaveLength(0);
  });

  it("invalid condition string → no crash, no event", () => {
    const config: EventConfig = {
      ...emptyConfig,
      thresholdTriggers: [
        {
          condition: "invalidFunction(topic) < 0",
          event: "Should not fire",
          actorArchetype: "institution",
        },
      ],
    };

    const events = processEvents(5, config, makeState({ recentPosts: [makePost()] }));
    expect(events).toHaveLength(0);
  });

  it("mixed event types in same round", () => {
    const posts = Array.from({ length: 10 }, (_, i) =>
      makePost({ id: `p-${i}`, topics: ["tuition"], sentiment: -0.9 })
    );
    const config: EventConfig = {
      initialPosts: [{ content: "Seed post", topics: ["tuition"] }],
      scheduled: [{ round: 0, content: "Scheduled", topics: ["media"] }],
      thresholdTriggers: [
        {
          condition: "avgSentiment(topic) < -0.6",
          event: "Trigger",
          actorArchetype: "institution",
        },
      ],
    };

    const events = processEvents(0, config, makeState({ recentPosts: posts }));
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.type).sort()).toEqual([
      "initial_post",
      "scheduled",
      "threshold_trigger",
    ]);
  });
});

// ═══════════════════════════════════════════════════════
// evaluateCondition (exported for direct testing)
// ═══════════════════════════════════════════════════════

describe("evaluateCondition", () => {
  it("iterates all observed topics independently", () => {
    const posts = [
      makePost({ id: "p1", topics: ["tuition"], sentiment: -0.9 }),
      makePost({ id: "p2", topics: ["tuition"], sentiment: -0.7 }),
      makePost({ id: "p3", topics: ["campus"], sentiment: 0.3 }),
      makePost({ id: "p4", topics: ["campus"], sentiment: 0.5 }),
    ];
    const state = makeState({ recentPosts: posts });

    const result = evaluateCondition("avgSentiment(topic) < -0.6", state);
    expect(result.fired).toBe(true);
    // tuition: avg = (-0.9 + -0.7) / 2 = -0.8 → matches
    // campus: avg = (0.3 + 0.5) / 2 = 0.4 → does not match
    expect(result.matchedTopics).toEqual(["tuition"]);
  });

  it("postCount with > operator", () => {
    const posts = Array.from({ length: 5 }, (_, i) =>
      makePost({ id: `p-${i}`, topics: ["campus"] })
    );
    const state = makeState({ recentPosts: posts });

    const above = evaluateCondition("postCount(topic) > 3", state);
    expect(above.fired).toBe(true);

    const below = evaluateCondition("postCount(topic) > 10", state);
    expect(below.fired).toBe(false);
  });
});
