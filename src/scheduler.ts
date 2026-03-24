/**
 * scheduler.ts — Round scheduler for per-actor decisions
 *
 * V2 execution model:
 * 1. Stage actor inputs sequentially to preserve deterministic PRNG usage
 * 2. Resolve Tier A/B backend calls with bounded concurrency
 * 3. Return an ordered action batch for a single commit phase in engine.ts
 */

import type {
  ActorRow,
  FeedItem,
  GraphStore,
  SearchRequestRow,
  SimEvent,
} from "./db.js";
import type { SimConfig } from "./config.js";
import type {
  CognitionBackend,
  CognitionRoute,
  DecisionRequest,
  DecisionResponse,
} from "./cognition.js";
import { buildFeed } from "./feed.js";
import {
  applyTierCRules,
  buildDecisionRequest,
  buildSimContext,
  routeCognition,
} from "./cognition.js";
import { hashDecisionRequest } from "./reproducibility.js";
import type { PlatformState, PRNG } from "./db.js";
import type { SearchProvider } from "./search.js";
import {
  buildSearchQueries,
  canActorSearch,
  formatSearchResults,
  resolveSearchLanguage,
  searchWithCache,
  selectSearchEnabledActors,
  toSearchRequestEntries,
  type SearchCandidate,
  type SearchExecution,
} from "./search.js";
import { getAllowedActionsForTier } from "./platform.js";
import { mapWithConcurrency } from "./concurrency.js";
import type { TemporalMemoryProvider } from "./temporal-memory.js";
import { retrieveTemporalContext } from "./temporal-memory-retrieval.js";

export interface ScheduledActorAction {
  index: number;
  actor: ActorRow;
  actorTopics: string[];
  feed: FeedItem[];
  route: CognitionRoute;
  decision: DecisionResponse;
  searchRequests: SearchRequestRow[];
  searchEligible: boolean;
  searchSelected: boolean;
  searchQueries: string[];
  requestHash?: string;
}

interface PendingBackendDecision {
  index: number;
  actor: ActorRow;
  actorTopics: string[];
  feed: FeedItem[];
  route: CognitionRoute;
  request: DecisionRequest;
  searchQueries: string[];
  searchEligible: boolean;
  searchSelected: boolean;
  requestHash: string;
}

export interface RoundSchedulerOptions {
  activeActors: ActorRow[];
  store: GraphStore;
  runId: string;
  roundNum: number;
  state: PlatformState;
  config: SimConfig;
  backend: CognitionBackend;
  rng: PRNG;
  activeEvents: SimEvent[];
  actorTopicsMap: Map<string, string[]>;
  actorBeliefsMap: Map<string, Record<string, number>>;
  lookbackRounds?: number;
  searchProvider?: SearchProvider | null;
  temporalMemoryProvider?: TemporalMemoryProvider | null;
}

export async function scheduleRoundActions(
  opts: RoundSchedulerOptions
): Promise<ScheduledActorAction[]> {
  const immediate: ScheduledActorAction[] = [];
  const pending: PendingBackendDecision[] = [];
  const searchCandidates: SearchCandidate[] = [];
  const lookbackRounds = opts.lookbackRounds ?? opts.config.cognition.interactionLookback;

  for (let index = 0; index < opts.activeActors.length; index++) {
    const actor = opts.activeActors[index];
    const actorTopics = opts.actorTopicsMap.get(actor.id) ?? [];
    const beliefs = opts.actorBeliefsMap.get(actor.id) ?? {};
    const feed = buildFeed(actor, opts.state, opts.config.feed, actorTopics);
    const route = routeCognition(
      actor,
      feed,
      opts.config.cognition,
      opts.rng,
      opts.activeEvents,
      actorTopics
    );
    const availableActions = getAllowedActionsForTier(opts.config.platform, route.tier);

    if (route.tier === "C") {
      immediate.push({
        index,
        actor,
        actorTopics,
        feed,
        route,
        decision: applyTierCRules(
          actor,
          feed,
          opts.config.cognition,
          opts.rng,
          availableActions
        ),
        searchRequests: [],
        searchEligible: false,
        searchSelected: false,
        searchQueries: [],
      });
      continue;
    }

    if (opts.searchProvider) {
      searchCandidates.push({ actor, tier: route.tier });
    }

    const simContext = buildSimContext(
      actor,
      opts.store,
      opts.runId,
      opts.roundNum,
      lookbackRounds
    );
    const request = buildDecisionRequest(
      actor,
      feed,
      beliefs,
      actorTopics,
      simContext,
      availableActions,
      opts.config.platform.name,
      opts.roundNum
    );
    const searchEligible = opts.searchProvider
      ? canActorSearch(actor, route.tier, opts.config.search)
      : false;
    pending.push({
      index,
      actor,
      actorTopics,
      feed,
      route,
      request,
      searchQueries: [],
      searchEligible,
      searchSelected: false,
      requestHash: hashDecisionRequest(request),
    });
  }

  const selectedForSearch = opts.searchProvider
    ? selectSearchEnabledActors(searchCandidates, opts.config.search)
    : new Set<string>();

  for (const job of pending) {
    job.searchSelected = selectedForSearch.has(job.actor.id);
    if (!job.searchSelected) continue;
    job.searchQueries = buildSearchQueries(
      job.actor,
      job.actorTopics,
      opts.activeEvents,
      job.feed,
      opts.config.search
    );
  }

  const resolved = await mapWithConcurrency(
    pending,
    Math.max(1, opts.config.simulation.concurrency),
    async (job) => ({
      index: job.index,
      actor: job.actor,
      actorTopics: job.actorTopics,
      feed: job.feed,
      route: job.route,
      searchEligible: job.searchEligible,
      searchSelected: job.searchSelected,
      searchQueries: job.searchQueries,
      requestHash: job.requestHash,
      ...(await resolveBackendDecision(job, opts)),
    })
  );

  return [...immediate, ...resolved].sort((a, b) => a.index - b.index);
}

async function resolveBackendDecision(
  job: PendingBackendDecision,
  opts: RoundSchedulerOptions
): Promise<{
  decision: DecisionResponse;
  searchRequests: SearchRequestRow[];
}> {
  let request = job.request;
  let searchRequests: SearchRequestRow[] = [];

  if (opts.searchProvider && job.searchQueries.length > 0) {
    const language = resolveSearchLanguage(job.actor.language, opts.config.search);
    const executions: SearchExecution[] = [];

    for (const query of job.searchQueries) {
      try {
        executions.push(
          await searchWithCache({
            store: opts.store,
            provider: opts.searchProvider,
            runId: opts.runId,
            query,
            config: opts.config.search,
            language,
          })
        );
      } catch {
        // Search is optional. Degrade gracefully to feed-only cognition.
      }
    }

    const webContext = formatSearchResults(executions, opts.config.search.cutoffDate, job.route.tier as "A" | "B");
    if (webContext) {
      request = { ...request, webContext };
    }
    searchRequests = toSearchRequestEntries(
      opts.runId,
      opts.roundNum,
      job.actor.id,
      opts.config.search.cutoffDate,
      executions
    );
  }

  // Temporal memory retrieval (Phase A4) — enrich context for Tier A/B
  if (
    opts.temporalMemoryProvider &&
    opts.config.temporalMemory.enabled &&
    (job.route.tier === "A" || job.route.tier === "B")
  ) {
    const tmResult = await retrieveTemporalContext(
      opts.temporalMemoryProvider,
      opts.runId,
      job.actor.id,
      job.actorTopics,
      job.route.tier,
      opts.config.temporalMemory
    );
    if (tmResult.text) {
      request = { ...request, temporalMemoryContext: tmResult.text };
    }
  }

  return {
    decision: await opts.backend.decide(request),
    searchRequests,
  };
}
