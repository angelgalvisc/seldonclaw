/**
 * feed.test.ts — Tests for feed ranking and partial exposure
 *
 * Covers:
 * - Follow posts, trending posts, community cross-posts
 * - Feed size limit
 * - Empty state → empty feed
 * - Recency, popularity, relevance weighting
 * - Echo chamber effect
 * - Actor's own posts excluded
 * - No duplicate posts
 * - Community affinity scoring
 */

import { describe, it, expect } from "vitest";
import type {
  ActorRow,
  PlatformState,
  PostSnapshot,
  FeedItem,
  CommunitySnapshot,
  ActorSnapshot,
  EngagementStats,
} from "../src/db.js";
import type { FeedConfig } from "../src/config.js";
import { buildFeed } from "../src/feed.js";

// ═══════════════════════════════════════════════════════
// TEST FIXTURES
// ═══════════════════════════════════════════════════════

const defaultFeedConfig: FeedConfig = {
  size: 20,
  algorithm: "hybrid",
  recencyWeight: 0.4,
  popularityWeight: 0.3,
  relevanceWeight: 0.3,
  echoChamberStrength: 0.5,
  traceWeight: 0.25,
  outOfNetworkRatio: 0.35,
  diversityWeight: 0.2,
  embeddingEnabled: false,
  embeddingWeight: 0.25,
  embeddingModel: "hash-embedding-v1",
  embeddingDimensions: 32,
};

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
    community_id: "comm-1",
    active_hours: null,
    follower_count: 50,
    following_count: 30,
    ...overrides,
  };
}

function makePost(overrides: Partial<PostSnapshot> = {}): PostSnapshot {
  return {
    id: "post-1",
    authorId: "author-1",
    content: "Test post",
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

function makePlatformState(
  overrides: Partial<PlatformState> = {}
): PlatformState {
  return {
    runId: "run-1",
    recentPosts: [],
    followGraph: new Map(),
    engagementByPost: new Map(),
    actors: new Map(),
    communities: [],
    exposedActors: new Map(),
    muteGraph: new Map(),
    blockGraph: new Map(),
    interactionTrace: new Map(),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════
// CANDIDATE SOURCES
// ═══════════════════════════════════════════════════════

describe("buildFeed — candidate sources", () => {
  it("includes posts from followed actors", () => {
    const post = makePost({ id: "p1", authorId: "author-a" });
    const state = makePlatformState({
      recentPosts: [post],
      followGraph: new Map([["actor-1", ["author-a"]]]),
      actors: new Map([["author-a", { id: "author-a", communityId: "", influenceWeight: 0.5, stance: "neutral", sentimentBias: 0 }]]),
    });

    const feed = buildFeed(makeActor(), state, defaultFeedConfig);
    expect(feed).toHaveLength(1);
    expect(feed[0].source).toBe("follow");
  });

  it("includes trending posts (high engagement)", () => {
    const trendingPost = makePost({
      id: "p1",
      authorId: "author-a",
      likes: 100,
      reposts: 50,
      comments: 30,
    });
    const state = makePlatformState({
      recentPosts: [trendingPost],
      actors: new Map([["author-a", { id: "author-a", communityId: "", influenceWeight: 0.5, stance: "neutral", sentimentBias: 0 }]]),
    });

    const feed = buildFeed(makeActor(), state, defaultFeedConfig);
    expect(feed).toHaveLength(1);
    expect(feed[0].source).toBe("trending");
  });

  it("includes community cross-posts", () => {
    const post = makePost({ id: "p1", authorId: "author-b" });
    const state = makePlatformState({
      recentPosts: [post],
      actors: new Map([
        ["author-b", { id: "author-b", communityId: "comm-2", influenceWeight: 0.5, stance: "neutral", sentimentBias: 0 }],
      ]),
      communities: [
        {
          id: "comm-1",
          cohesion: 0.7,
          memberIds: ["actor-1"],
          overlaps: new Map([["comm-2", 0.5]]),
        },
        {
          id: "comm-2",
          cohesion: 0.6,
          memberIds: ["author-b"],
          overlaps: new Map([["comm-1", 0.5]]),
        },
      ],
    });

    const feed = buildFeed(
      makeActor({ community_id: "comm-1" }),
      state,
      defaultFeedConfig
    );
    expect(feed).toHaveLength(1);
    expect(feed[0].source).toBe("community");
  });

  it("excludes actor's own posts", () => {
    const ownPost = makePost({ id: "p1", authorId: "actor-1" });
    const otherPost = makePost({ id: "p2", authorId: "author-a" });
    const state = makePlatformState({
      recentPosts: [ownPost, otherPost],
      actors: new Map([
        ["actor-1", { id: "actor-1", communityId: "", influenceWeight: 0.5, stance: "neutral", sentimentBias: 0 }],
        ["author-a", { id: "author-a", communityId: "", influenceWeight: 0.5, stance: "neutral", sentimentBias: 0 }],
      ]),
    });

    const feed = buildFeed(makeActor(), state, defaultFeedConfig);
    expect(feed).toHaveLength(1);
    expect(feed[0].post.id).toBe("p2");
  });

  it("no duplicate posts across sources", () => {
    // author-a is both followed AND has high engagement
    const post = makePost({
      id: "p1",
      authorId: "author-a",
      likes: 100,
      reposts: 50,
    });
    const state = makePlatformState({
      recentPosts: [post],
      followGraph: new Map([["actor-1", ["author-a"]]]),
      actors: new Map([["author-a", { id: "author-a", communityId: "", influenceWeight: 0.5, stance: "neutral", sentimentBias: 0 }]]),
    });

    const feed = buildFeed(makeActor(), state, defaultFeedConfig);
    expect(feed).toHaveLength(1);
    expect(feed[0].source).toBe("follow"); // follow wins over trending
  });
});

// ═══════════════════════════════════════════════════════
// SCORING
// ═══════════════════════════════════════════════════════

describe("buildFeed — scoring", () => {
  it("more recent posts rank higher", () => {
    const oldPost = makePost({ id: "old", authorId: "a1", roundNum: 1, likes: 5, reposts: 1, comments: 1 });
    const newPost = makePost({ id: "new", authorId: "a2", roundNum: 10, likes: 5, reposts: 1, comments: 1 });
    const state = makePlatformState({
      recentPosts: [oldPost, newPost],
      actors: new Map([
        ["a1", { id: "a1", communityId: "", influenceWeight: 0.5, stance: "neutral", sentimentBias: 0 }],
        ["a2", { id: "a2", communityId: "", influenceWeight: 0.5, stance: "neutral", sentimentBias: 0 }],
      ]),
    });

    const feed = buildFeed(makeActor(), state, { ...defaultFeedConfig, popularityWeight: 0, relevanceWeight: 0 });
    expect(feed[0].post.id).toBe("new");
  });

  it("higher engagement posts rank higher", () => {
    const lowEng = makePost({ id: "low", authorId: "a1", roundNum: 5, likes: 1, reposts: 0, comments: 0 });
    const highEng = makePost({ id: "high", authorId: "a2", roundNum: 5, likes: 50, reposts: 20, comments: 10 });
    const state = makePlatformState({
      recentPosts: [lowEng, highEng],
      actors: new Map([
        ["a1", { id: "a1", communityId: "", influenceWeight: 0.5, stance: "neutral", sentimentBias: 0 }],
        ["a2", { id: "a2", communityId: "", influenceWeight: 0.5, stance: "neutral", sentimentBias: 0 }],
      ]),
    });

    const feed = buildFeed(makeActor(), state, { ...defaultFeedConfig, recencyWeight: 0, relevanceWeight: 0 });
    expect(feed[0].post.id).toBe("high");
  });

  it("relevant posts rank higher when relevanceWeight > 0", () => {
    const relevant = makePost({ id: "rel", authorId: "a1", roundNum: 5, topics: ["education"], likes: 5, reposts: 1, comments: 1 });
    const irrelevant = makePost({ id: "irr", authorId: "a2", roundNum: 5, topics: ["sports"], likes: 5, reposts: 1, comments: 1 });
    const state = makePlatformState({
      recentPosts: [relevant, irrelevant],
      actors: new Map([
        ["a1", { id: "a1", communityId: "", influenceWeight: 0.5, stance: "neutral", sentimentBias: 0 }],
        ["a2", { id: "a2", communityId: "", influenceWeight: 0.5, stance: "neutral", sentimentBias: 0 }],
      ]),
    });

    const feed = buildFeed(
      makeActor(),
      state,
      { ...defaultFeedConfig, recencyWeight: 0, popularityWeight: 0 },
      ["education"]
    );
    expect(feed[0].post.id).toBe("rel");
  });

  it("embedding similarity boosts aligned candidates when enabled", () => {
    const aligned = makePost({ id: "aligned", authorId: "a1", roundNum: 5, topics: ["misc"] });
    const distant = makePost({ id: "distant", authorId: "a2", roundNum: 5, topics: ["misc"] });
    const state = makePlatformState({
      recentPosts: [aligned, distant],
      actors: new Map([
        ["a1", { id: "a1", communityId: "", influenceWeight: 0.5, stance: "neutral", sentimentBias: 0 }],
        ["a2", { id: "a2", communityId: "", influenceWeight: 0.5, stance: "neutral", sentimentBias: 0 }],
      ]),
      postEmbeddings: new Map([
        ["aligned", [1, 0]],
        ["distant", [0, 1]],
      ]),
      actorInterestEmbeddings: new Map([["actor-1", [1, 0]]]),
    });

    const feed = buildFeed(
      makeActor(),
      state,
      {
        ...defaultFeedConfig,
        recencyWeight: 0,
        popularityWeight: 0,
        relevanceWeight: 0,
        embeddingEnabled: true,
        embeddingWeight: 0.8,
      }
    );

    expect(feed[0].post.id).toBe("aligned");
  });
});

// ═══════════════════════════════════════════════════════
// ECHO CHAMBER
// ═══════════════════════════════════════════════════════

describe("buildFeed — echo chamber", () => {
  it("boosts aligned posts when community cohesion is high", () => {
    const alignedPost = makePost({ id: "aligned", authorId: "a1", sentiment: 0.8, likes: 5, reposts: 1, comments: 1, roundNum: 5 });
    const opposedPost = makePost({ id: "opposed", authorId: "a2", sentiment: -0.8, likes: 5, reposts: 1, comments: 1, roundNum: 5 });

    const state = makePlatformState({
      recentPosts: [alignedPost, opposedPost],
      actors: new Map([
        ["a1", { id: "a1", communityId: "comm-1", influenceWeight: 0.5, stance: "supportive", sentimentBias: 0.5 }],
        ["a2", { id: "a2", communityId: "comm-1", influenceWeight: 0.5, stance: "opposing", sentimentBias: -0.5 }],
      ]),
      communities: [{
        id: "comm-1",
        cohesion: 0.9,
        memberIds: ["actor-1", "a1", "a2"],
        overlaps: new Map(),
      }],
    });

    // Actor has positive sentiment_bias → aligned with positive sentiment posts
    const feed = buildFeed(
      makeActor({ sentiment_bias: 0.5, community_id: "comm-1" }),
      state,
      { ...defaultFeedConfig, echoChamberStrength: 1.0 }
    );

    expect(feed[0].post.id).toBe("aligned");
    expect(feed[0].score).toBeGreaterThan(feed[1].score);
  });

  it("no echo chamber effect when echoChamberStrength is 0", () => {
    const alignedPost = makePost({ id: "aligned", authorId: "a1", sentiment: 0.8, likes: 5, reposts: 1, comments: 1, roundNum: 5 });
    const opposedPost = makePost({ id: "opposed", authorId: "a2", sentiment: -0.8, likes: 5, reposts: 1, comments: 1, roundNum: 5 });

    const state = makePlatformState({
      recentPosts: [alignedPost, opposedPost],
      actors: new Map([
        ["a1", { id: "a1", communityId: "comm-1", influenceWeight: 0.5, stance: "supportive", sentimentBias: 0.5 }],
        ["a2", { id: "a2", communityId: "comm-1", influenceWeight: 0.5, stance: "opposing", sentimentBias: -0.5 }],
      ]),
      communities: [{
        id: "comm-1",
        cohesion: 0.9,
        memberIds: ["actor-1", "a1", "a2"],
        overlaps: new Map(),
      }],
    });

    const feed = buildFeed(
      makeActor({ sentiment_bias: 0.5, community_id: "comm-1" }),
      state,
      { ...defaultFeedConfig, echoChamberStrength: 0 }
    );

    // Without echo chamber, both should have similar scores
    const diff = Math.abs(feed[0].score - feed[1].score);
    expect(diff).toBeLessThan(0.01);
  });
});

// ═══════════════════════════════════════════════════════
// EDGE CASES
// ═══════════════════════════════════════════════════════

describe("buildFeed — edge cases", () => {
  it("empty state returns empty feed", () => {
    const feed = buildFeed(makeActor(), makePlatformState(), defaultFeedConfig);
    expect(feed).toHaveLength(0);
  });

  it("feed size is respected", () => {
    const posts = Array.from({ length: 30 }, (_, i) =>
      makePost({ id: `p${i}`, authorId: `a${i}`, roundNum: i })
    );
    const actors = new Map(
      posts.map((p) => [
        p.authorId,
        { id: p.authorId, communityId: "", influenceWeight: 0.5, stance: "neutral", sentimentBias: 0 } as ActorSnapshot,
      ])
    );
    const state = makePlatformState({ recentPosts: posts, actors });

    const feed = buildFeed(makeActor(), state, { ...defaultFeedConfig, size: 5 });
    expect(feed).toHaveLength(5);
  });

  it("single post in platform state", () => {
    const post = makePost({ id: "p1", authorId: "other" });
    const state = makePlatformState({
      recentPosts: [post],
      actors: new Map([["other", { id: "other", communityId: "", influenceWeight: 0.5, stance: "neutral", sentimentBias: 0 }]]),
    });

    const feed = buildFeed(makeActor(), state, defaultFeedConfig);
    expect(feed).toHaveLength(1);
  });

  it("actor with no follows and no community still gets trending", () => {
    const post = makePost({ id: "p1", authorId: "other", likes: 100 });
    const state = makePlatformState({
      recentPosts: [post],
      actors: new Map([["other", { id: "other", communityId: "", influenceWeight: 0.5, stance: "neutral", sentimentBias: 0 }]]),
    });

    const feed = buildFeed(
      makeActor({ community_id: null }),
      state,
      defaultFeedConfig
    );
    expect(feed).toHaveLength(1);
    expect(feed[0].source).toBe("trending");
  });

  it("filters muted authors from the feed", () => {
    const state = makePlatformState({
      recentPosts: [makePost({ id: "muted-post", authorId: "muted-author" })],
      actors: new Map([["muted-author", { id: "muted-author", communityId: "", influenceWeight: 0.5, stance: "neutral", sentimentBias: 0 }]]),
      muteGraph: new Map([["actor-1", new Set(["muted-author"])]]),
    });

    const feed = buildFeed(makeActor(), state, defaultFeedConfig);
    expect(feed).toHaveLength(0);
  });

  it("filters authors who block the viewer", () => {
    const state = makePlatformState({
      recentPosts: [makePost({ id: "blocked-post", authorId: "hostile-author" })],
      actors: new Map([["hostile-author", { id: "hostile-author", communityId: "", influenceWeight: 0.5, stance: "neutral", sentimentBias: 0 }]]),
      blockGraph: new Map([["hostile-author", new Set(["actor-1"])]]),
    });

    const feed = buildFeed(makeActor(), state, defaultFeedConfig);
    expect(feed).toHaveLength(0);
  });

  it("trace-aware ranking boosts authors with prior engagement", () => {
    const familiar = makePost({ id: "familiar", authorId: "author-a", roundNum: 5 });
    const stranger = makePost({ id: "stranger", authorId: "author-b", roundNum: 5 });
    const state = makePlatformState({
      recentPosts: [stranger, familiar],
      actors: new Map([
        ["author-a", { id: "author-a", communityId: "", influenceWeight: 0.5, stance: "neutral", sentimentBias: 0 }],
        ["author-b", { id: "author-b", communityId: "", influenceWeight: 0.5, stance: "neutral", sentimentBias: 0 }],
      ]),
      interactionTrace: new Map([
        [
          "actor-1",
          {
            engagedPostIds: new Set(["older-post"]),
            authorScores: new Map([["author-a", 5]]),
            topicScores: new Map([["education", 3]]),
            inNetworkScore: 2,
            outOfNetworkScore: 1,
          },
        ],
      ]),
    });

    const feed = buildFeed(makeActor(), state, {
      ...defaultFeedConfig,
      algorithm: "trace-aware",
      recencyWeight: 0,
      popularityWeight: 0,
      relevanceWeight: 0,
      traceWeight: 1,
    });

    expect(feed[0].post.id).toBe("familiar");
  });
});
