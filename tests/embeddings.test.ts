import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SQLiteGraphStore, type ActorRow, type PlatformState, type PostSnapshot } from "../src/db.js";
import { defaultConfig } from "../src/config.js";
import {
  HashEmbeddingProvider,
  attachEmbeddingsToPlatformState,
  buildActorInterestText,
  buildPostEmbeddingText,
  ensureActorInterestEmbeddings,
  ensurePostEmbeddings,
} from "../src/embeddings.js";

const runId = "embed-run";

describe("embeddings.ts", () => {
  let store: SQLiteGraphStore;

  beforeEach(() => {
    store = new SQLiteGraphStore(":memory:");
    store.createRun({
      id: runId,
      started_at: new Date().toISOString(),
      seed: 42,
      config_snapshot: "{}",
      graph_revision_id: "rev-embed",
      status: "running",
      total_rounds: 2,
    });
  });

  afterEach(() => {
    store.close();
  });

  it("hash provider is deterministic", async () => {
    const provider = new HashEmbeddingProvider("hash-embedding-v1", 16);
    const [a, b] = await provider.embedTexts(["education policy", "education policy"]);
    expect(a).toEqual(b);
  });

  it("caches post embeddings in the store", async () => {
    const provider = new HashEmbeddingProvider("hash-embedding-v1", 16);
    store.addActor(makeActor({ id: "author-1" }));
    store.addPost({
      id: "post-1",
      run_id: runId,
      author_id: "author-1",
      content: "Students reject the tuition increase",
      round_num: 1,
      sim_timestamp: "2024-01-01T01:00:00",
      likes: 5,
      reposts: 2,
      comments: 1,
      reach: 30,
      sentiment: -0.6,
    });
    store.addPostTopic("post-1", "education");
    const posts: PostSnapshot[] = [
      {
        id: "post-1",
        authorId: "author-1",
        content: "Students reject the tuition increase",
        roundNum: 1,
        simTimestamp: "2024-01-01T01:00:00",
        topics: ["education"],
        sentiment: -0.6,
        likes: 5,
        reposts: 2,
        comments: 1,
        reach: 30,
      },
    ];

    const first = await ensurePostEmbeddings(store, posts, provider);
    const second = await ensurePostEmbeddings(store, posts, provider);

    expect(first.get("post-1")).toEqual(second.get("post-1"));
  });

  it("attaches actor and post embeddings to platform state", async () => {
    const provider = new HashEmbeddingProvider("hash-embedding-v1", 16);
    const actor = makeActor();
    store.addActor(actor);
    store.addActorTopic(actor.id, "education", 1);
    store.addActorBelief(actor.id, "education", -0.4, 0);
    store.addPost({
      id: "post-1",
      run_id: runId,
      author_id: actor.id,
      content: "Education budgets are collapsing.",
      round_num: 0,
      sim_timestamp: "2024-01-01T00:00:00",
      likes: 0,
      reposts: 0,
      comments: 0,
      reach: 0,
      sentiment: -0.4,
    });
    store.addPostTopic("post-1", "education");

    const state: PlatformState = store.buildPlatformState(runId, 1, 5);
    const actorTopicsMap = new Map([[actor.id, ["education"]]]);
    const actorBeliefsMap = new Map([[actor.id, { education: -0.4 }]]);
    const enriched = await attachEmbeddingsToPlatformState({
      state,
      store,
      provider,
      actors: [actor],
      actorTopicsMap,
      actorBeliefsMap,
    });

    expect(enriched.postEmbeddings?.has("post-1")).toBe(true);
    expect(enriched.actorInterestEmbeddings?.has(actor.id)).toBe(true);
  });

  it("builds stable actor interest text", () => {
    const text = buildActorInterestText(
      makeActor(),
      ["education", "policy"],
      { policy: 0.2, education: -0.4 }
    );
    expect(text).toContain("Elena Ruiz");
    expect(text).toContain("education, policy");
    expect(text).toContain("education:-0.40");
  });

  it("builds post embedding text from topics and content", () => {
    const text = buildPostEmbeddingText({
      id: "post-1",
      authorId: "actor-1",
      content: "Policy update",
      roundNum: 1,
      simTimestamp: "2024-01-01T01:00:00",
      topics: ["policy"],
      sentiment: 0,
      likes: 0,
      reposts: 0,
      comments: 0,
      reach: 0,
    });

    expect(text).toContain("actor-1");
    expect(text).toContain("policy");
    expect(text).toContain("Policy update");
  });

  it("caches actor interest embeddings in the store", async () => {
    const provider = new HashEmbeddingProvider("hash-embedding-v1", 16);
    const actor = makeActor();
    store.addActor(actor);
    const actorTopicsMap = new Map([[actor.id, ["education"]]]);
    const actorBeliefsMap = new Map([[actor.id, { education: -0.4 }]]);

    const first = await ensureActorInterestEmbeddings(
      store,
      [actor],
      actorTopicsMap,
      actorBeliefsMap,
      provider
    );
    const second = await ensureActorInterestEmbeddings(
      store,
      [actor],
      actorTopicsMap,
      actorBeliefsMap,
      provider
    );

    expect(first.get(actor.id)).toEqual(second.get(actor.id));
  });
});

function makeActor(overrides: Partial<ActorRow> = {}): ActorRow {
  const config = defaultConfig();
  return {
    id: "actor-1",
    run_id: runId,
    entity_id: null,
    archetype: "persona",
    cognition_tier: "B",
    name: "Elena Ruiz",
    handle: "@elena",
    personality: "A policy analyst focused on education financing.",
    bio: null,
    age: 31,
    gender: "female",
    profession: "analyst",
    region: "Bogota",
    language: "es",
    stance: "critical",
    sentiment_bias: -0.2,
    activity_level: 0.7,
    influence_weight: config.cognition.tierA.minInfluence,
    community_id: null,
    active_hours: null,
    follower_count: 100,
    following_count: 70,
    ...overrides,
  };
}
