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

export interface SearchCandidate {
  actor: ActorRow;
  tier: "A" | "B" | "C";
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

async function fetchWithRetry(
  url: string | URL,
  init: RequestInit,
  maxRetries = 3
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timeoutId);
      if (response.ok) return response;
      if (response.status >= 400 && response.status < 500) {
        throw new Error(`Search API returned ${response.status}`);
      }
      lastError = new Error(`Search API returned ${response.status}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    if (attempt < maxRetries - 1) {
      await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt)));
    }
  }
  throw lastError ?? new Error("Search failed after retries");
}

export class SearxngSearchProvider implements SearchProvider {
  constructor(private endpoint: string) {}

  async search(query: string, options: SearchProviderOptions): Promise<SearchResult[]> {
    const searchUrl = normalizeSearchEndpoint(this.endpoint);
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("format", "json");
    searchUrl.searchParams.set("categories", options.categories);
    searchUrl.searchParams.set("language", options.language);

    const response = await fetchWithRetry(searchUrl, {
      headers: {
        accept: "application/json",
      },
    });

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

  // Get the top feed post content for query enrichment
  const sortedFeed = [...feed].sort((a, b) => b.score - a.score);
  const feedTopPost = sortedFeed.length > 0 ? sortedFeed[0].post.content : undefined;

  for (const event of activeEvents) {
    const overlappingTopics = event.topics.filter((topic) => actorTopicSet.has(topic));
    const prioritizedTopics = overlappingTopics.length > 0 ? overlappingTopics : event.topics;
    for (const topic of prioritizedTopics) {
      queryParts.push(composeQuery(topic, actor, feedTopPost));
    }
  }

  for (const topic of actorTopics) {
    queryParts.push(composeQuery(topic, actor, feedTopPost));
  }

  const seenFeedTopics = new Set<string>();
  for (const item of sortedFeed) {
    for (const topic of item.post.topics) {
      if (seenFeedTopics.has(topic)) continue;
      seenFeedTopics.add(topic);
      queryParts.push(composeQuery(topic, actor, feedTopPost));
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
  cutoffDate: string,
  tier?: "A" | "B"
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
    // Tier B actors get headlines only (titles); Tier A gets full results (title + snippet)
    if (tier === "B") {
      return `${index + 1}. "${result.title}" — ${source}${published}`;
    }
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

export function canActorSearch(
  actor: ActorRow,
  tier: "A" | "B" | "C",
  config: SearchConfig
): boolean {
  if (!shouldSearchTier(tier, config)) return false;

  const actorTokens = [actor.id, actor.handle ?? "", actor.name]
    .map(normalizeToken)
    .filter(Boolean);
  const denyActors = new Set(config.denyActors.map(normalizeToken).filter(Boolean));
  if (actorTokens.some((token) => denyActors.has(token))) {
    return false;
  }

  const archetype = normalizeToken(actor.archetype);
  if (config.denyArchetypes.map(normalizeToken).includes(archetype)) {
    return false;
  }

  const profession = normalizeToken(actor.profession ?? "");
  if (config.denyProfessions.map(normalizeToken).includes(profession)) {
    return false;
  }

  const allowActors = config.allowActors.map(normalizeToken).filter(Boolean);
  const allowedArchetypes = config.allowArchetypes.map(normalizeToken).filter(Boolean);
  const allowedProfessions = config.allowProfessions.map(normalizeToken).filter(Boolean);

  const hasAllowPolicy =
    allowActors.length > 0 ||
    allowedArchetypes.length > 0 ||
    allowedProfessions.length > 0;

  if (!hasAllowPolicy) {
    return true;
  }

  // Profession matching uses substring containment — an actor with profession
  // "Equity Research Analyst (Cybersecurity/Defense Technology)" should match
  // allowProfession "cybersecurity analyst". Both sides are already normalized
  // to lowercase by normalizeToken().
  const professionMatches = allowedProfessions.some(
    (allowed) => profession.includes(allowed) || allowed.includes(profession)
  );

  return (
    actorTokens.some((token) => allowActors.includes(token)) ||
    allowedArchetypes.includes(archetype) ||
    professionMatches
  );
}

export function selectSearchEnabledActors(
  candidates: SearchCandidate[],
  config: SearchConfig
): Set<string> {
  if (!config.enabled || config.maxActorsPerRound === 0) {
    return new Set();
  }

  const eligible = candidates
    .filter((candidate) => canActorSearch(candidate.actor, candidate.tier, config))
    .sort(compareSearchCandidates);

  const selected = new Set<string>();
  const remainingPerTier = {
    A: config.maxActorsByTier.A,
    B: config.maxActorsByTier.B,
  };

  for (const candidate of eligible) {
    if (selected.size >= config.maxActorsPerRound) break;
    if (candidate.tier === "C") continue;
    if (remainingPerTier[candidate.tier] <= 0) continue;
    selected.add(candidate.actor.id);
    remainingPerTier[candidate.tier]--;
  }

  return selected;
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

/**
 * Compose a clean search query from a topic + optional feed context.
 * Keep queries short and focused — search engines perform worse with
 * long multi-concept queries. Do NOT include profession, region, or
 * actor metadata in the query (those pollute search results with
 * irrelevant geographic/occupational noise).
 */
function composeQuery(topic: string, _actor: ActorRow, feedTopPost?: string): string {
  const parts = [topic.trim()];
  // Add 1-2 contextual keywords from the top feed post (if relevant)
  if (feedTopPost) {
    // Extract meaningful keywords (>5 chars, no common words)
    const stopwords = new Set(["about", "their", "would", "could", "should", "being", "which", "there", "these", "those", "after", "before", "while", "where", "other"]);
    const words = feedTopPost
      .split(/\s+/)
      .map(w => w.replace(/[^a-zA-Z0-9]/g, ""))
      .filter(w => w.length > 5 && !stopwords.has(w.toLowerCase()));
    // Take up to 2 unique keywords not already in the topic
    const topicLower = topic.toLowerCase();
    const added: string[] = [];
    for (const w of words) {
      if (added.length >= 2) break;
      if (topicLower.includes(w.toLowerCase())) continue;
      added.push(w);
    }
    if (added.length > 0) parts.push(added.join(" "));
  }
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

function compareSearchCandidates(a: SearchCandidate, b: SearchCandidate): number {
  const tierRank = tierPriority(a.tier) - tierPriority(b.tier);
  if (tierRank !== 0) return tierRank;

  const influenceRank = b.actor.influence_weight - a.actor.influence_weight;
  if (Math.abs(influenceRank) > Number.EPSILON) return influenceRank;

  return a.actor.id.localeCompare(b.actor.id);
}

function tierPriority(tier: "A" | "B" | "C"): number {
  switch (tier) {
    case "A":
      return 0;
    case "B":
      return 1;
    default:
      return 2;
  }
}

function normalizeToken(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ");

  if (!normalized) return "";

  const aliases: Array<[string[], string]> = [
    [
      [
        "markets journalist",
        "market journalist",
        "financial journalist",
        "business journalist",
        "market reporter",
        "markets reporter",
        "periodista de mercados",
        "periodistas de mercados",
      ],
      "markets journalist",
    ],
    [
      [
        "technology journalist",
        "tech journalist",
        "technology reporter",
        "tech reporter",
        "periodista de tecnologia",
        "periodistas de tecnologia",
        "periodista de tecnología",
        "periodistas de tecnología",
      ],
      "technology journalist",
    ],
    [
      [
        "macro trader",
        "macro traders",
        "macro investor",
        "macro investors",
        "trader macro",
        "traders macro",
      ],
      "macro trader",
    ],
    [
      [
        "crypto trader",
        "crypto traders",
        "trader cripto",
        "traders cripto",
        "spot crypto trader",
        "perp crypto trader",
      ],
      "crypto trader",
    ],
  ];

  for (const [variants, canonical] of aliases) {
    if (variants.includes(normalized)) return canonical;
  }

  return normalized;
}
