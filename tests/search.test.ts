import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SQLiteGraphStore, type ActorRow, type SimEvent } from "../src/db.js";
import { defaultConfig } from "../src/config.js";
import { MockCognitionBackend } from "../src/cognition.js";
import { scheduleRoundActions } from "../src/scheduler.js";
import { SeedablePRNG } from "../src/reproducibility.js";
import {
  MockSearchProvider,
  buildSearchQueries,
  filterSearchResultsByCutoff,
  formatSearchResults,
  searchWithCache,
  shouldSearchTier,
  type SearchProvider,
} from "../src/search.js";

describe("search.ts", () => {
  let store: SQLiteGraphStore;

  beforeEach(() => {
    store = new SQLiteGraphStore(":memory:");
    store.createRun({
      id: "run-search",
      started_at: new Date().toISOString(),
      seed: 42,
      config_snapshot: "{}",
      graph_revision_id: "rev-search",
      status: "running",
      total_rounds: 2,
    });
  });

  afterEach(() => {
    store.close();
  });

  it("returns cached results on second call", async () => {
    const provider = new CountingSearchProvider([
      {
        title: "Tuition reform advances",
        url: "https://example.com/tuition-reform",
        snippet: "Lawmakers advance the tuition reform proposal.",
        source: "Example News",
        publishedAt: "2026-02-28T00:00:00.000Z",
      },
    ]);
    const config = defaultConfig();
    config.search.enabled = true;
    config.search.cutoffDate = "2026-03-01";

    const first = await searchWithCache({
      store,
      provider,
      runId: "run-search",
      query: "tuition reform bogota",
      config: config.search,
      language: "es",
    });
    const second = await searchWithCache({
      store,
      provider,
      runId: "run-search",
      query: "tuition reform bogota",
      config: config.search,
      language: "es",
    });

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(provider.calls).toBe(1);
  });

  it("filterByCutoff removes results after cutoff date", () => {
    const results = filterSearchResultsByCutoff(
      [
        {
          title: "Before cutoff",
          url: "https://example.com/before",
          snippet: "Allowed result",
          publishedAt: "2026-02-28T00:00:00.000Z",
        },
        {
          title: "After cutoff",
          url: "https://example.com/after",
          snippet: "Filtered result",
          publishedAt: "2026-03-02T00:00:00.000Z",
        },
      ],
      "2026-03-01",
      true
    );

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Before cutoff");
  });

  it("buildSearchQueries generates relevant queries from actor context", () => {
    const config = defaultConfig();
    config.search.enabled = true;
    config.search.maxQueriesPerActor = 2;

    const actor = makeActor();
    const queries = buildSearchQueries(
      actor,
      ["economy", "tax"],
      [
        {
          type: "scheduled",
          round: 1,
          content: "Tax reform enters debate",
          topics: ["tax", "budget"],
        },
      ],
      [
        {
          post: {
            id: "post-1",
            authorId: "actor-2",
            content: "Budget pressure increases",
            roundNum: 1,
            simTimestamp: "2024-01-01T01:00:00",
            topics: ["budget"],
            sentiment: -0.2,
            likes: 2,
            reposts: 1,
            comments: 0,
            reach: 10,
          },
          score: 0.9,
          source: "trending",
        },
      ],
      config.search
    );

    expect(queries.length).toBeGreaterThan(0);
    expect(queries[0]).toContain("tax");
    expect(queries[0]).toContain("Bogota");
  });

  it("formats search results into web context", () => {
    const context = formatSearchResults(
      [
        {
          query: "tax reform bogota",
          language: "es",
          categories: "news",
          cacheHit: false,
          results: [
            {
              title: "Tax reform advances",
              url: "https://example.com/reform",
              snippet: "Congress moved the reform forward.",
              source: "Example News",
              publishedAt: "2026-02-28T00:00:00.000Z",
            },
          ],
        },
      ],
      "2026-03-01"
    );

    expect(context).toContain("RECENT WEB INFORMATION");
    expect(context).toContain("Tax reform advances");
    expect(context).toContain("2026-02-28");
  });

  it("search is disabled by default", () => {
    const config = defaultConfig();
    const queries = buildSearchQueries(makeActor(), ["economy"], [], [], config.search);
    expect(config.search.enabled).toBe(false);
    expect(queries).toEqual([]);
  });

  it("Tier C actors never trigger search", () => {
    const config = defaultConfig();
    config.search.enabled = true;
    expect(shouldSearchTier("C", config.search)).toBe(false);
    expect(shouldSearchTier("A", config.search)).toBe(true);
  });

  it("cache key includes cutoff date", async () => {
    const provider = new CountingSearchProvider([
      {
        title: "Budget news",
        url: "https://example.com/budget",
        snippet: "Budget update",
        publishedAt: "2026-02-28T00:00:00.000Z",
      },
    ]);
    const config = defaultConfig();
    config.search.enabled = true;

    await searchWithCache({
      store,
      provider,
      runId: "run-search",
      query: "budget bogota",
      config: { ...config.search, cutoffDate: "2026-03-01" },
      language: "es",
    });
    await searchWithCache({
      store,
      provider,
      runId: "run-search",
      query: "budget bogota",
      config: { ...config.search, cutoffDate: "2026-02-27" },
      language: "es",
    });

    expect(provider.calls).toBe(2);
  });

  it("gracefully degrades when the search provider is unreachable", async () => {
    const actor = makeActor({ cognition_tier: "A", influence_weight: 0.95 });
    store.addActor(actor);
    store.addActorTopic(actor.id, "economy", 1);
    store.addActorBelief(actor.id, "economy", 0.2, 0);

    const config = defaultConfig();
    config.search.enabled = true;
    config.search.maxQueriesPerActor = 1;
    const backend = new MockCognitionBackend();
    backend.setDefault({ action: "idle", reasoning: "no-op" });

    const scheduled = await scheduleRoundActions({
      activeActors: [actor],
      store,
      runId: "run-search",
      roundNum: 1,
      state: store.buildPlatformState("run-search", 1, 5),
      config,
      backend,
      rng: new SeedablePRNG(42),
      activeEvents: [
        { type: "scheduled", round: 1, content: "Economy shock", topics: ["economy"] },
      ] satisfies SimEvent,
      actorTopicsMap: new Map([[actor.id, ["economy"]]]),
      actorBeliefsMap: new Map([[actor.id, { economy: 0.2 }]]),
      searchProvider: new ThrowingSearchProvider(),
    });

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].decision.action).toBe("idle");
    expect(scheduled[0].searchRequests).toEqual([]);
    expect(backend.decideCalls[0]?.webContext).toBeUndefined();
  });
});

class CountingSearchProvider implements SearchProvider {
  calls = 0;

  constructor(private results: Array<{
    title: string;
    url: string;
    snippet: string;
    source?: string;
    publishedAt?: string | null;
  }>) {}

  async search(): Promise<Array<{
    title: string;
    url: string;
    snippet: string;
    source?: string;
    publishedAt?: string | null;
  }>> {
    this.calls++;
    return this.results;
  }
}

class ThrowingSearchProvider implements SearchProvider {
  async search(): Promise<never> {
    throw new Error("unreachable");
  }
}

function makeActor(overrides: Partial<ActorRow> = {}): ActorRow {
  return {
    id: "actor-1",
    run_id: "run-search",
    entity_id: null,
    archetype: "persona",
    cognition_tier: "B",
    name: "Elena Ruiz",
    handle: "@elena",
    personality: "A journalist focused on public policy.",
    bio: null,
    age: 30,
    gender: "female",
    profession: "journalist",
    region: "Bogota",
    language: "es",
    stance: "critical",
    sentiment_bias: -0.2,
    activity_level: 1,
    influence_weight: 0.7,
    community_id: null,
    active_hours: null,
    follower_count: 120,
    following_count: 80,
    ...overrides,
  };
}
