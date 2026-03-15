import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SQLiteGraphStore, type ActorRow } from "../src/db.js";
import type { ScheduledActorAction } from "../src/scheduler.js";
import { deriveActorMemories, persistActorMemories } from "../src/memory.js";
import { buildSimContext } from "../src/cognition.js";

const runId = "memory-run";
const actorId = "actor-memory";

describe("memory.ts", () => {
  let store: SQLiteGraphStore;

  beforeEach(() => {
    store = new SQLiteGraphStore(":memory:");
    store.createRun({
      id: runId,
      started_at: new Date().toISOString(),
      seed: 42,
      config_snapshot: "{}",
      graph_revision_id: "rev-memory",
      status: "running",
      total_rounds: 3,
    });
    store.addActor(makeActor());
    store.addActorTopic(actorId, "education", 1);
    store.addActorBelief(actorId, "education", -0.4, 0);
  });

  afterEach(() => {
    store.close();
  });

  it("derives reflection, interaction, event, and narrative memories for Tier A/B actors", () => {
    const memories = deriveActorMemories(
      runId,
      2,
      makeScheduledAction(),
      [
        {
          type: "scheduled",
          round: 2,
          content: "Breaking update on education funding",
          topics: ["education"],
          actor_id: "institution-1",
        },
      ],
      [
        {
          id: "n1",
          run_id: runId,
          topic: "education",
          first_round: 0,
          peak_round: 1,
          current_intensity: 0.8,
          total_posts: 10,
          dominant_sentiment: -0.5,
        },
      ]
    );

    expect(memories.length).toBeGreaterThanOrEqual(3);
    expect(memories.some((m) => m.kind === "reflection")).toBe(true);
    expect(memories.some((m) => m.kind === "interaction")).toBe(true);
    expect(memories.some((m) => m.kind === "event")).toBe(true);
    expect(memories.some((m) => m.kind === "narrative")).toBe(true);
  });

  it("persists memories and exposes them through buildSimContext", () => {
    store.addActor(
      makeActor({
        id: "student-1",
        name: "Student One",
        handle: "@student1",
        archetype: "persona",
        cognition_tier: "B",
        influence_weight: 0.4,
      })
    );
    store.addPost({
      id: "feed-post-1",
      run_id: runId,
      author_id: "student-1",
      content: "The tuition increase is unacceptable and students are mobilizing.",
      round_num: 2,
      sim_timestamp: "2024-01-01T02:00:00",
      likes: 12,
      reposts: 5,
      comments: 3,
      reach: 100,
      sentiment: -0.7,
    });
    store.addPostTopic("feed-post-1", "education");

    persistActorMemories(
      store,
      runId,
      2,
      [makeScheduledAction()],
      [
        {
          type: "threshold_trigger",
          round: 2,
          content: "Students escalate protests around tuition",
          topics: ["education"],
          actor_id: "student-1",
        },
      ],
      [
        {
          id: "n1",
          run_id: runId,
          topic: "education",
          first_round: 0,
          peak_round: 1,
          current_intensity: 0.7,
          total_posts: 12,
          dominant_sentiment: -0.4,
        },
      ]
    );

    const memories = store.getActorMemories(actorId, runId, 5);
    expect(memories.length).toBeGreaterThan(0);

    const context = buildSimContext(makeActor(), store, runId, 2, 5);
    expect(context).toContain("What you remember most:");
    expect(context).toContain("tuition");
  });
});

function makeActor(overrides: Partial<ActorRow> = {}): ActorRow {
  return {
    id: actorId,
    run_id: runId,
    entity_id: null,
    archetype: "media",
    cognition_tier: "A",
    name: "Elena Ruiz",
    handle: "@elena",
    personality: "A journalist who tracks education policy closely.",
    bio: null,
    age: 33,
    gender: "female",
    profession: "journalist",
    region: "Bogota",
    language: "es",
    stance: "critical",
    sentiment_bias: -0.2,
    activity_level: 0.7,
    influence_weight: 0.9,
    community_id: null,
    active_hours: null,
    follower_count: 200,
    following_count: 120,
    ...overrides,
  };
}

function makeScheduledAction(): ScheduledActorAction {
  return {
    index: 0,
    actor: makeActor(),
    actorTopics: ["education"],
    feed: [
      {
        post: {
          id: "feed-post-1",
          authorId: "student-1",
          content: "The tuition increase is unacceptable and students are mobilizing.",
          roundNum: 2,
          simTimestamp: "2024-01-01T02:00:00",
          topics: ["education"],
          sentiment: -0.7,
          likes: 12,
          reposts: 5,
          comments: 3,
          reach: 100,
        },
        score: 0.91,
        source: "trending",
      },
    ],
    route: { tier: "A", reason: "high influence" },
    decision: {
      action: "post",
      content: "Investigating the impact of tuition policy changes.",
      reasoning: "The protests and budget documents suggest this issue now defines the conversation.",
    },
  };
}
