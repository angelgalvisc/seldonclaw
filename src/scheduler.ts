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
import type { PlatformState, PRNG } from "./db.js";
import type { SearchProvider } from "./search.js";
import {
  buildSearchQueries,
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

export interface ScheduledActorAction {
  index: number;
  actor: ActorRow;
  actorTopics: string[];
  feed: FeedItem[];
  route: CognitionRoute;
  decision: DecisionResponse;
  searchRequests: SearchRequestRow[];
}

interface PendingBackendDecision {
  index: number;
  actor: ActorRow;
  actorTopics: string[];
  feed: FeedItem[];
  route: CognitionRoute;
  request: DecisionRequest;
  searchQueries: string[];
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
    pending.push({
      index,
      actor,
      actorTopics,
      feed,
      route,
      request,
      searchQueries: [],
    });
  }

  const selectedForSearch = opts.searchProvider
    ? selectSearchEnabledActors(searchCandidates, opts.config.search)
    : new Set<string>();

  for (const job of pending) {
    if (!selectedForSearch.has(job.actor.id)) continue;
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

    const webContext = formatSearchResults(executions, opts.config.search.cutoffDate);
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

  return {
    decision: await opts.backend.decide(request),
    searchRequests,
  };
}

