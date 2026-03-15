import { URL } from "node:url";
import { stableId } from "./db.js";
import type { ActorRow, FeedItem, GraphStore, SimEvent } from "./db.js";
import type { SearchConfig } from "./config.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  publishedAt?: string | null;
}

export interface SearchExecution {
  query: string;
  language: string;
  categories: string;
  cacheHit: boolean;
  results: SearchResult[];
}

export interface SearchProviderOptions {
  language: string;
  categories: string;
  maxResults: number;
  timeoutMs: number;
}

export interface SearchProvider {
  search(query: string, options: SearchProviderOptions): Promise<SearchResult[]>;
}

interface SearxngResponse {
  results?: unknown[];
}

interface SearchWithCacheOptions {
  store: GraphStore;
  provider: SearchProvider;
  runId: string;
  query: string;
  config: SearchConfig;
  language: string;
}

export class SearxngSearchProvider implements SearchProvider {
  constructor(private endpoint: string) {}

  async search(query: string, options: SearchProviderOptions): Promise<SearchResult[]> {
    const searchUrl = normalizeSearchEndpoint(this.endpoint);
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("format", "json");
    searchUrl.searchParams.set("categories", options.categories);
    searchUrl.searchParams.set("language", options.language);

    const response = await fetch(searchUrl, {
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: {
        accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`SearXNG request failed (${response.status})`);
    }

    const payload = (await response.json()) as SearxngResponse;
    const normalized = (payload.results ?? [])
      .map((result) => normalizeSearchResult(result))
      .filter((result): result is SearchResult => result !== null);

    return normalized.slice(0, options.maxResults);
  }
}

export class MockSearchProvider implements SearchProvider {
  private resultsByQuery = new Map<string, SearchResult[]>();

  setResults(query: string, results: SearchResult[]): void {
    this.resultsByQuery.set(query, results);
  }

  async search(query: string, options: SearchProviderOptions): Promise<SearchResult[]> {
    return (this.resultsByQuery.get(query) ?? []).slice(0, options.maxResults);
  }
}

export function createSearchProvider(config: SearchConfig): SearchProvider {
  return new SearxngSearchProvider(config.endpoint);
}

export async function checkSearchHealth(
  provider: SearchProvider,
  config: SearchConfig
): Promise<void> {
  await provider.search("status", {
    language: resolveSearchLanguage("en", config),
    categories: config.categories,
    maxResults: 1,
    timeoutMs: config.timeoutMs,
  });
}

export function buildSearchQueries(
  actor: ActorRow,
  actorTopics: string[],
  activeEvents: SimEvent[],
  feed: FeedItem[],
  config: SearchConfig
): string[] {
  if (!config.enabled || config.maxQueriesPerActor === 0) {
    return [];
  }

  const queryParts: string[] = [];
  const actorTopicSet = new Set(actorTopics);

  for (const event of activeEvents) {
    const overlappingTopics = event.topics.filter((topic) => actorTopicSet.has(topic));
    const prioritizedTopics = overlappingTopics.length > 0 ? overlappingTopics : event.topics;
    for (const topic of prioritizedTopics) {
      queryParts.push(composeQuery(topic, actor));
    }
  }

  for (const topic of actorTopics) {
    queryParts.push(composeQuery(topic, actor));
  }

  const seenFeedTopics = new Set<string>();
  for (const item of [...feed].sort((a, b) => b.score - a.score)) {
    for (const topic of item.post.topics) {
      if (seenFeedTopics.has(topic)) continue;
      seenFeedTopics.add(topic);
      queryParts.push(composeQuery(topic, actor));
    }
  }

  const unique = new Set<string>();
  const queries: string[] = [];
  for (const query of queryParts) {
    if (!query || unique.has(query)) continue;
    unique.add(query);
    queries.push(query);
    if (queries.length >= config.maxQueriesPerActor) break;
  }

  return queries;
}

export async function searchWithCache(
  opts: SearchWithCacheOptions
): Promise<SearchExecution> {
  const categories = opts.config.categories;
  const cutoffDate = opts.config.cutoffDate;
  const cached = opts.store.getSearchCache(
    opts.query,
    cutoffDate,
    opts.language,
    categories
  );

  if (cached) {
    return {
      query: opts.query,
      language: opts.language,
      categories,
      cacheHit: true,
      results: parseCachedResults(cached.results),
    };
  }

  const rawResults = await opts.provider.search(opts.query, {
    language: opts.language,
    categories,
    maxResults: opts.config.maxResultsPerQuery,
    timeoutMs: opts.config.timeoutMs,
  });
  const filtered = filterSearchResultsByCutoff(
    rawResults,
    cutoffDate,
    opts.config.strictCutoff
  ).slice(0, opts.config.maxResultsPerQuery);

  opts.store.upsertSearchCache({
    id: stableId("search-cache", opts.query, cutoffDate, opts.language, categories),
    query: opts.query,
    cutoff_date: cutoffDate,
    language: opts.language,
    categories,
    results: JSON.stringify(filtered),
    fetched_at: new Date().toISOString(),
    run_id: opts.runId,
  });

  return {
    query: opts.query,
    language: opts.language,
    categories,
    cacheHit: false,
    results: filtered,
  };
}

export function filterSearchResultsByCutoff(
  results: SearchResult[],
  cutoffDate: string,
  strictCutoff: boolean
): SearchResult[] {
  const cutoffTime = Date.parse(cutoffDate);
  if (Number.isNaN(cutoffTime)) {
    return results;
  }

  return results.filter((result) => {
    if (!result.publishedAt) {
      return !strictCutoff;
    }
    const publishedAt = Date.parse(result.publishedAt);
    if (Number.isNaN(publishedAt)) {
      return !strictCutoff;
    }
    return publishedAt <= cutoffTime;
  });
}

export function formatSearchResults(
  executions: SearchExecution[],
  cutoffDate: string
): string | undefined {
  const deduped = new Map<string, SearchResult>();
  for (const execution of executions) {
    for (const result of execution.results) {
      if (!deduped.has(result.url)) {
        deduped.set(result.url, result);
      }
    }
  }

  if (deduped.size === 0) return undefined;

  const lines = [...deduped.values()].slice(0, 5).map((result, index) => {
    const source = result.source ?? safeHostname(result.url);
    const published = result.publishedAt ? `, ${result.publishedAt.slice(0, 10)}` : "";
    return (
      `${index + 1}. "${result.title}" — ${source}${published}\n` +
      `   ${result.snippet}`
    );
  });

  return `RECENT WEB INFORMATION (cutoff: ${cutoffDate}):\n${lines.join("\n")}`;
}

export function shouldSearchTier(
  tier: "A" | "B" | "C",
  config: SearchConfig
): boolean {
  return config.enabled && tier !== "C" && config.enabledTiers.includes(tier);
}

export function resolveSearchLanguage(
  actorLanguage: string | undefined,
  config: SearchConfig
): string {
  if (config.defaultLanguage === "auto") {
    return actorLanguage?.trim() || "en";
  }
  return config.defaultLanguage;
}

export function toSearchRequestEntries(
  runId: string,
  roundNum: number,
  actorId: string,
  cutoffDate: string,
  executions: SearchExecution[]
): Array<{
  id: string;
  run_id: string;
  round_num: number;
  actor_id: string;
  query: string;
  cutoff_date: string;
  language: string;
  categories: string;
  cache_hit: number;
  result_count: number;
}> {
  return executions.map((execution) => ({
    id: stableId(
      "search-request",
      runId,
      actorId,
      String(roundNum),
      execution.query,
      execution.language,
      execution.categories
    ),
    run_id: runId,
    round_num: roundNum,
    actor_id: actorId,
    query: execution.query,
    cutoff_date: cutoffDate,
    language: execution.language,
    categories: execution.categories,
    cache_hit: execution.cacheHit ? 1 : 0,
    result_count: execution.results.length,
  }));
}

function normalizeSearchEndpoint(endpoint: string): URL {
  const normalized = endpoint.endsWith("/search")
    ? endpoint
    : `${endpoint.replace(/\/$/, "")}/search`;
  return new URL(normalized);
}

function normalizeSearchResult(raw: unknown): SearchResult | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const title = String(obj.title ?? "").trim();
  const url = String(obj.url ?? "").trim();
  const snippet = String(obj.content ?? obj.snippet ?? "").trim();
  if (!title || !url) {
    return null;
  }

  return {
    title,
    url,
    snippet,
    source: resolveSourceName(obj),
    publishedAt: resolvePublishedAt(obj),
  };
}

function resolvePublishedAt(obj: Record<string, unknown>): string | null {
  const candidates = [
    obj.publishedAt,
    obj.publishedDate,
    obj.published_date,
    obj.published,
    obj.date,
    obj.pubdate,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      const parsed = Date.parse(candidate);
      if (!Number.isNaN(parsed)) {
        return new Date(parsed).toISOString();
      }
    }
  }
  return null;
}

function resolveSourceName(obj: Record<string, unknown>): string | undefined {
  if (typeof obj.engine === "string" && obj.engine.trim()) {
    return obj.engine.trim();
  }
  if (Array.isArray(obj.engines) && typeof obj.engines[0] === "string") {
    return String(obj.engines[0]);
  }
  if (typeof obj.source === "string" && obj.source.trim()) {
    return obj.source.trim();
  }
  return undefined;
}

function composeQuery(topic: string, actor: ActorRow): string {
  const parts = [topic.trim()];
  if (actor.region) parts.push(actor.region.trim());
  return parts.filter(Boolean).join(" ");
}

function parseCachedResults(json: string): SearchResult[] {
  try {
    const data = JSON.parse(json) as unknown;
    if (!Array.isArray(data)) return [];
    return data
      .map((item) => normalizeSearchResult(item))
      .filter((item): item is SearchResult => item !== null);
  } catch {
    return [];
  }
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown-source";
  }
}
