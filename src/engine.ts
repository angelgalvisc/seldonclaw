/**
 * engine.ts — Main simulation loop
 *
 * Source of truth: PLAN.md §Architecture, §Per-Actor Per-Round Flow
 *                  CLAUDE.md Phase 5.1
 *
 * Orchestrates all modules per round:
 *   events → fatigue → activation → feed → cognition → execute → propagation → telemetry
 *
 * Pure orchestration — no LLM logic here. Delegates to:
 *   - activation.ts (who comes online)
 *   - feed.ts (what each actor sees)
 *   - cognition.ts (routing + decision)
 *   - telemetry.ts (structured logging)
 */

import type {
  ActorRow,
  GraphStore,
  Post,
  RoundContext,
  FeedItem,
  SimEvent,
} from "./db.js";
import type { SimConfig } from "./config.js";
import type { CognitionBackend, DecisionResponse } from "./cognition.js";
import { deriveActivationConfig, totalRounds, sanitizeForStorage } from "./config.js";
import { computeActivation } from "./activation.js";
import { logAction, updateRound } from "./telemetry.js";
import { SeedablePRNG, saveSnapshot } from "./reproducibility.js";
import { stableId, uuid } from "./db.js";
import { processEvents } from "./events.js";
import { propagate } from "./propagation.js";
import { updateFatigue } from "./fatigue.js";
import { scheduleRoundActions } from "./scheduler.js";
import { persistActorMemories } from "./memory.js";
import {
  attachEmbeddingsToPlatformState,
  createEmbeddingProvider,
  createEmbeddingProviderAsync,
} from "./embeddings.js";
import { createSearchProvider, type SearchProvider } from "./search.js";
import {
  createTemporalMemoryProvider,
  type TemporalMemoryProvider,
} from "./temporal-memory.js";
import { deriveTemporalEpisodes, flushOutboxToProvider } from "./temporal-memory-mapper.js";
import { applyAutomaticModeration } from "./moderation.js";
import {
  getAllowedActionsForTier,
  isActionAllowedForTier,
} from "./platform.js";
import {
  planIdleFastForward,
  shouldAttemptIdleFastForward,
} from "./time-policy.js";
import { SimulationCancelledError, throwIfStopRequested } from "./run-control.js";
import { resolveProviderConfig } from "./provider-selection.js";
import { evaluateRound, buildRoundGuidance, type RoundEvaluation } from "./round-evaluator.js";

// ═══════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════

export interface EngineResult {
  runId: string;
  totalRounds: number;
  completedRounds: number;
  status: "completed" | "failed" | "cancelled";
  wallTimeMs: number;
  failureMessage?: string | null;
}

export interface EngineRoundProgress {
  runId: string;
  roundNum: number;
  totalRounds: number;
  activeActors: number;
  totalPosts: number;
  totalActions: number;
  tierACalls: number;
  tierBCalls: number;
  tierCActions: number;
  wallTimeMs: number;
}

export interface EngineCallbacks {
  onRoundComplete?: (progress: EngineRoundProgress) => void;
}

export interface EngineOptions {
  store: GraphStore;
  config: SimConfig;
  backend: CognitionBackend;
  runId?: string;
  startRound?: number;
  initialRngState?: string;
  initialFiredTriggers?: string[];
  searchProvider?: SearchProvider | null;
  temporalMemoryProvider?: TemporalMemoryProvider | null;
  callbacks?: EngineCallbacks;
  signal?: AbortSignal;
  shouldStop?: () => boolean;
}

interface ExecutableActorAction {
  actor: ActorRow;
  actorTopics: string[];
  routeTier: "A" | "B" | "C";
  decision: DecisionResponse;
  feed: FeedItem[];
}

// ═══════════════════════════════════════════════════════
// MAIN SIMULATION LOOP
// ═══════════════════════════════════════════════════════

export async function runSimulation(opts: EngineOptions): Promise<EngineResult> {
  const { store, config, backend } = opts;
  const t0 = Date.now();
  const numRounds = totalRounds(config);
  const runId = opts.runId ?? uuid();
  const startRound = Math.max(0, opts.startRound ?? 0);

  // 1. Initialize
  const rng = opts.initialRngState
    ? SeedablePRNG.fromState(opts.initialRngState)
    : new SeedablePRNG(config.simulation.seed);
  const graphRevisionId = store.computeGraphRevisionId();

  // Create or update run manifest
  const existingRun = store.getRun(runId);
  if (existingRun) {
    store.updateRun(runId, {
      status: "running",
      seed: config.simulation.seed,
      config_snapshot: sanitizeForStorage(config),
      graph_revision_id: graphRevisionId,
      total_rounds: numRounds,
    });
  } else {
    store.createRun({
      id: runId,
      started_at: new Date().toISOString(),
      seed: config.simulation.seed,
      config_snapshot: sanitizeForStorage(config),
      graph_revision_id: graphRevisionId,
      total_rounds: numRounds,
      status: "running",
    });
  }

  await backend.start();

  const allActors = store.getActorsByRun(runId);
  const activationConfig = deriveActivationConfig(config);
  const embeddingProvider =
    config.feed.embeddingEnabled || config.feed.twhin?.enabled
      ? await createEmbeddingProviderAsync(config.feed)
      : null;
  const searchProvider =
    opts.searchProvider !== undefined
      ? opts.searchProvider
      : config.search.enabled
        ? createSearchProvider(config.search)
        : null;

  // Temporal memory provider (Graphiti or Noop)
  const temporalMemoryProvider =
    opts.temporalMemoryProvider !== undefined
      ? opts.temporalMemoryProvider
      : await createTemporalMemoryProvider(config.temporalMemory);

  // Simulation start time (round 0 = 2024-01-01T00:00:00 in configured timezone)
  const startTime = new Date("2024-01-01T00:00:00");
  let completedRounds = startRound;

  // Round evaluator guidance — injected into next round's decision prompts
  let roundGuidance: string | null = null;

  // Threshold triggers fire once and are remembered across rounds.
  const firedTriggers = new Set<string>(opts.initialFiredTriggers ?? []);

  // Cost tracking — abort simulation if cumulative LLM spend exceeds the cap
  const costTracker = {
    totalUsd: 0,
    maxUsd: config.simulation.costCapUsd ?? 20,
    track(inputTokens: number, outputTokens: number, model: string) {
      // Rough estimates per 1K tokens
      const rates: Record<string, { input: number; output: number }> = {
        'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
        'gpt-4o': { input: 0.0025, output: 0.01 },
        'claude-3-5-haiku-latest': { input: 0.0008, output: 0.004 },
        'claude-sonnet-4-20250514': { input: 0.003, output: 0.015 },
      };
      const rate = rates[model] ?? { input: 0.001, output: 0.004 };
      this.totalUsd += (inputTokens / 1000) * rate.input + (outputTokens / 1000) * rate.output;
      if (this.totalUsd >= this.maxUsd) {
        throw new Error(`Cost cap exceeded: $${this.totalUsd.toFixed(2)} >= $${this.maxUsd}. Simulation aborted.`);
      }
    }
  };

  try {
    if (startRound === 0 && !store.getRunScaffold(runId)) {
      store.saveRunScaffold(runId, store.captureRunScaffold(runId));
    }

    // 2. Per-round loop
    for (let roundNum = startRound; roundNum < numRounds; roundNum++) {
      throwIfStopRequested({
        signal: opts.signal,
        shouldStop: opts.shouldStop,
        message: "Simulation stop requested before starting the next round.",
      });
      const roundT0 = Date.now();

      const simTimestamp = computeSimTimestamp(
        startTime,
        roundNum,
        config.simulation.minutesPerRound
      );
      const simHour = computeSimHour(simTimestamp);

      // Build PlatformState (read-only snapshot for this round)
      const state = store.buildPlatformState(runId, roundNum, 5);

      // ── Phase 6: Events (BEFORE activation) ──
      const activeEvents = processEvents(roundNum, config.events, state, firedTriggers);

      // Materialize events as posts so they enter feeds and propagation
      for (const event of activeEvents) {
        const authorId = findEventAuthor(allActors, event)
          ?? allActors[roundNum % allActors.length]?.id; // fallback to a real actor if archetype not found
        if (!authorId) continue; // skip event if no actors at all
        event.actor_id = authorId;
        const postId = stableId("event", runId, event.type, String(roundNum), event.content.slice(0, 20));
        const eventPost: Post = {
          id: postId,
          run_id: runId,
          author_id: authorId,
          content: event.content,
          round_num: roundNum,
          sim_timestamp: simTimestamp,
          likes: 0,
          reposts: 0,
          comments: 0,
          reach: 0,
          sentiment: 0,
        };
        store.addPost(eventPost);
        for (const topic of event.topics) {
          store.addPostTopic(postId, topic);
        }
      }

      // ── Phase 6: Fatigue decay + re-activation ──
      const narratives = store.getNarrativesByRun(runId);
      const { updated: updatedNarratives } = updateFatigue(
        narratives,
        roundNum,
        config.fatigue
      );

      // Re-activate extinct narratives if events touch their topics
      const eventTopics = new Set(activeEvents.flatMap((e) => e.topics));
      for (const narrative of updatedNarratives) {
        if (
          eventTopics.has(narrative.topic) &&
          narrative.current_intensity < config.fatigue.extinctionThreshold
        ) {
          narrative.current_intensity = Math.min(
            1.0,
            narrative.current_intensity + config.fatigue.reactivationBoost
          );
          narrative.peak_round = roundNum;
        }
      }

      // Build RoundContext with real events
      const round: RoundContext = {
        runId,
        roundNum,
        simTimestamp,
        simHour,
        activeEvents,
        rng,
      };

      // Load actor topics map (bulk)
      const actorTopicsMap = store.getActorTopicsByRun(runId);
      const actorBeliefsMap = store.getActorBeliefsByRun(runId);

      // Activation (with fatigue penalty from narratives)
      const { activeActors } = computeActivation(
        allActors,
        round,
        activationConfig,
        actorTopicsMap,
        updatedNarratives
      );

      if (
        shouldAttemptIdleFastForward({
          mode: config.simulation.timeAccelerationMode,
          currentState: state,
          currentEvents: activeEvents,
          currentActiveActors: activeActors,
        })
      ) {
        const fastForwardPlan = planIdleFastForward({
          mode: config.simulation.timeAccelerationMode,
          startRoundNum: roundNum,
          totalRounds: numRounds,
          currentSimTimestamp: simTimestamp,
          currentState: state,
          currentEvents: activeEvents,
          currentActiveActors: activeActors,
          currentNarratives: updatedNarratives,
          allActors,
          actorTopicsMap,
          activationConfig,
          eventsConfig: config.events,
          fatigueConfig: config.fatigue,
          startTime,
          minutesPerRound: config.simulation.minutesPerRound,
          maxFastForwardRounds: config.simulation.maxFastForwardRounds,
          rng,
        });

        if (fastForwardPlan && fastForwardPlan.rounds.length > 0) {
          throwIfStopRequested({
            signal: opts.signal,
            shouldStop: opts.shouldStop,
            message: "Simulation stop requested before applying fast-forward rounds.",
          });
          const actorStates =
            config.simulation.snapshotEvery > 0
              ? buildActorSnapshotState(store, runId)
              : [];

          store.executeInTransaction(() => {
            persistNarratives(store, fastForwardPlan.finalNarratives);

            for (const [index, skippedRound] of fastForwardPlan.rounds.entries()) {
              updateRound(store, {
                num: skippedRound.roundNum,
                runId,
                simTime: skippedRound.simTimestamp,
                activeActors: 0,
                totalPosts: 0,
                totalActions: 0,
                tierACalls: 0,
                tierBCalls: 0,
                tierCActions: 0,
                events: [],
                wallTimeMs: index === 0 ? Date.now() - roundT0 : 0,
              });

              if (
                config.simulation.snapshotEvery > 0 &&
                skippedRound.roundNum > 0 &&
                skippedRound.roundNum % config.simulation.snapshotEvery === 0
              ) {
                saveSnapshot(store, {
                  runId,
                  roundNum: skippedRound.roundNum,
                  actorStates,
                  narrativeStates: buildNarrativeSnapshotState(skippedRound.narratives),
                  firedTriggers,
                  rng,
                });
              }
            }

            const firstRound = fastForwardPlan.rounds[0];
            const lastRound =
              fastForwardPlan.rounds[fastForwardPlan.rounds.length - 1];
            store.addSkippedRoundSpan({
              id: stableId(
                "skip",
                runId,
                String(firstRound.roundNum),
                String(lastRound.roundNum)
              ),
              run_id: runId,
              from_round: firstRound.roundNum,
              to_round: lastRound.roundNum,
              sim_time_start: firstRound.simTimestamp,
              sim_time_end: lastRound.simTimestamp,
              reason: fastForwardPlan.reason,
              novelty_score: 0,
              pending_events: fastForwardPlan.pendingEvents,
            });
          });

          roundNum = fastForwardPlan.rounds[fastForwardPlan.rounds.length - 1].roundNum;
          completedRounds = roundNum + 1;
          continue;
        }
      }

      // Stage actor decisions deterministically, then resolve Tier A/B with bounded concurrency.
      const feedState = embeddingProvider
        ? await attachEmbeddingsToPlatformState({
            state,
            store,
            provider: embeddingProvider,
            actors: activeActors,
            actorTopicsMap,
            actorBeliefsMap,
          })
        : state;

      throwIfStopRequested({
        signal: opts.signal,
        shouldStop: opts.shouldStop,
        message: "Simulation stop requested before scheduling actor actions.",
      });

      const scheduledActions = await scheduleRoundActions({
        activeActors,
        store,
        runId,
        roundNum,
        state: feedState,
        config,
        backend,
        rng,
        activeEvents,
        actorTopicsMap,
        actorBeliefsMap,
        searchProvider,
        temporalMemoryProvider,
        roundGuidance,
      });

      throwIfStopRequested({
        signal: opts.signal,
        shouldStop: opts.shouldStop,
        message: "Simulation stop requested after scheduling actions for the current round.",
      });

      let totalPosts = 0;
      const totalActions = scheduledActions.length;
      const tierACalls = scheduledActions.filter((a) => a.route.tier === "A").length;
      const tierBCalls = scheduledActions.filter((a) => a.route.tier === "B").length;
      const tierCActions = scheduledActions.filter((a) => a.route.tier === "C").length;

      store.executeInTransaction(() => {
        persistNarratives(store, updatedNarratives);

        for (const scheduled of scheduledActions) {
          const normalizedDecision = normalizeDecisionForPlatform(
            config,
            scheduled.route.tier,
            scheduled.decision
          );
          const executable: ExecutableActorAction = {
            actor: scheduled.actor,
            actorTopics: scheduled.actorTopics,
            routeTier: scheduled.route.tier,
            decision: normalizedDecision,
            feed: scheduled.feed,
          };

          totalPosts += executeDecision(
            store,
            runId,
            roundNum,
            executable.actor,
            executable.routeTier,
            executable.decision,
            simTimestamp,
            executable.actorTopics,
            config
          );

          logAction(
            store,
            runId,
            roundNum,
            executable.actor.id,
            executable.routeTier,
            executable.decision.action,
            JSON.stringify({
              ...executable.decision,
              feedSize: executable.feed.length,
            })
          );

          const cachedDecision = scheduled.requestHash
            ? store.getCachedDecisionMetadata(runId, scheduled.requestHash)
            : null;
          store.logDecisionTrace({
            id: stableId("decision-trace", runId, scheduled.actor.id, String(roundNum)),
            run_id: runId,
            round_num: roundNum,
            actor_id: scheduled.actor.id,
            route_tier: scheduled.route.tier,
            route_reason: scheduled.route.reason,
            search_eligible: scheduled.searchEligible ? 1 : 0,
            search_selected: scheduled.searchSelected ? 1 : 0,
            search_queries: scheduled.searchQueries.length > 0 ? JSON.stringify(scheduled.searchQueries) : null,
            search_request_ids:
              scheduled.searchRequests.length > 0
                ? JSON.stringify(scheduled.searchRequests.map((request) => request.id))
                : null,
            request_hash: scheduled.requestHash ?? null,
            model_id: cachedDecision?.model_id ?? null,
            prompt_version: cachedDecision?.prompt_version ?? null,
            raw_decision: scheduled.requestHash
              ? (cachedDecision?.parsed_decision ?? JSON.stringify(scheduled.decision))
              : JSON.stringify(scheduled.decision),
            normalized_decision: JSON.stringify(normalizedDecision),
            final_action: executable.decision.action,
            normalization_reason:
              JSON.stringify(scheduled.decision) !== JSON.stringify(normalizedDecision)
                ? normalizedDecision.reasoning ?? `Decision normalized for ${config.platform.name}`
                : null,
            tier_c_rule_reason:
              scheduled.route.tier === "C" ? scheduled.decision.reasoning ?? null : null,
          });

          for (const searchRequest of scheduled.searchRequests) {
            store.addSearchRequest(searchRequest);
          }
        }

        persistActorMemories(
          store,
          runId,
          roundNum,
          scheduledActions,
          activeEvents,
          updatedNarratives
        );

        // Temporal memory: derive episodes and write to outbox (separate from flat memory)
        // Reference: PLAN_PRODUCT_EVOLUTION.md §4.6 — keep these as separate steps
        if (temporalMemoryProvider) {
          deriveTemporalEpisodes(
            store,
            runId,
            roundNum,
            scheduledActions,
            activeEvents,
            updatedNarratives
          );
        }

        const moderationDecisions = applyAutomaticModeration(
          store,
          runId,
          roundNum,
          config.platform.moderation
        );
        for (const moderation of moderationDecisions) {
          if (moderation.status === "none") continue;
          logAction(
            store,
            runId,
            roundNum,
            undefined,
            undefined,
            "moderation",
            JSON.stringify(moderation)
          );
        }

        // ── Phase 6: Propagation (AFTER execute) ──
        // Intentional one-round latency: propagation uses `state` built at the
        // start of this round, so it spreads posts from PREVIOUS rounds.
        // Posts created in the current round (including event posts) will be
        // propagated next round. A post cannot spread the instant it's created.
        const propagationResult = propagate(state, config.propagation, roundNum, rng);
        for (const [postId, delta] of propagationResult.reachDeltas) {
          store.updatePostEngagement(postId, "reach", delta);
        }
        for (const exposure of propagationResult.newExposures) {
          store.addExposure(exposure);
        }

        // Update round aggregates
        const roundWallTimeMs = Date.now() - roundT0;
        updateRound(store, {
          num: roundNum,
          runId,
          simTime: simTimestamp,
          activeActors: activeActors.length,
          totalPosts,
          totalActions,
          tierACalls,
          tierBCalls,
          tierCActions,
          events: activeEvents,
          wallTimeMs: roundWallTimeMs,
        });

        opts.callbacks?.onRoundComplete?.({
          runId,
          roundNum,
          totalRounds: numRounds,
          activeActors: activeActors.length,
          totalPosts,
          totalActions,
          tierACalls,
          tierBCalls,
          tierCActions,
          wallTimeMs: roundWallTimeMs,
        });
      });

      // Cost estimation — rough per-round estimate based on tier call counts.
      // Tier A calls use the simulation provider model; Tier B uses the same.
      // Estimate ~800 input tokens and ~200 output tokens per LLM call.
      {
        const llmCalls = tierACalls + tierBCalls;
        if (llmCalls > 0) {
          const model = resolveProviderConfig(config.providers, "simulation").model;
          const estInputTokens = 800;
          const estOutputTokens = 200;
          for (let i = 0; i < llmCalls; i++) {
            costTracker.track(estInputTokens, estOutputTokens, model);
          }
        }
      }

      // Temporal memory: flush outbox to Graphiti (async, outside SQLite transaction)
      // Failures are logged but do not stop the simulation.
      if (temporalMemoryProvider) {
        await flushOutboxToProvider(store, runId, roundNum, temporalMemoryProvider);
      }

      // Round evaluator: independent quality assessment (Generator-Evaluator pattern)
      // Runs after temporal memory flush, before snapshot. Failures are non-fatal.
      if (config.simulation.roundEvaluator?.enabled && roundNum < numRounds - 1) {
        try {
          const evaluation = await evaluateRound(backend.llm, store, runId, roundNum);
          roundGuidance = buildRoundGuidance(evaluation);
        } catch {
          // Evaluator failure is non-fatal
        }
      }

      completedRounds = roundNum + 1;

      // Snapshot
      if (
        config.simulation.snapshotEvery > 0 &&
        roundNum > 0 &&
        roundNum % config.simulation.snapshotEvery === 0
      ) {
        saveSnapshot(store, {
          runId,
          roundNum,
          actorStates: buildActorSnapshotState(store, runId),
          narrativeStates: buildNarrativeSnapshotState(store.getNarrativesByRun(runId)),
          firedTriggers,
          rng,
        });
      }
    }

    // 3. Complete
    store.updateRun(runId, {
      status: "completed",
      finished_at: new Date().toISOString(),
      total_rounds: numRounds,
    });

    return {
      runId,
      totalRounds: numRounds,
      completedRounds,
      status: "completed",
      wallTimeMs: Date.now() - t0,
      failureMessage: null,
    };
  } catch (err) {
    if (err instanceof SimulationCancelledError) {
      const latestSnapshot = store.getLatestSnapshot(runId);
      const lastCompletedRound = completedRounds - 1;
      if (lastCompletedRound >= 0 && latestSnapshot?.round_num !== lastCompletedRound) {
        saveSnapshot(store, {
          runId,
          roundNum: lastCompletedRound,
          actorStates: buildActorSnapshotState(store, runId),
          narrativeStates: buildNarrativeSnapshotState(store.getNarrativesByRun(runId)),
          firedTriggers,
          rng,
        });
      }
      store.updateRun(runId, {
        status: "cancelled",
        finished_at: new Date().toISOString(),
        total_rounds: numRounds,
      });

      return {
        runId,
        totalRounds: numRounds,
        completedRounds,
        status: "cancelled",
        wallTimeMs: Date.now() - t0,
        failureMessage: null,
      };
    }
    const failureMessage =
      err instanceof Error
        ? [err.name, err.message, err.stack?.split("\n").slice(0, 4).join("\n")]
            .filter(Boolean)
            .join(": ")
        : String(err);
    const latestSnapshot = store.getLatestSnapshot(runId);
    const lastCompletedRound = completedRounds - 1;
    if (lastCompletedRound >= 0 && latestSnapshot?.round_num !== lastCompletedRound) {
      saveSnapshot(store, {
        runId,
        roundNum: lastCompletedRound,
        actorStates: buildActorSnapshotState(store, runId),
        narrativeStates: buildNarrativeSnapshotState(store.getNarrativesByRun(runId)),
        firedTriggers,
        rng,
      });
    }
    store.updateRun(runId, {
      status: "failed",
      finished_at: new Date().toISOString(),
      failure_message: failureMessage,
    });

    return {
      runId,
      totalRounds: numRounds,
      completedRounds,
      status: "failed",
      wallTimeMs: Date.now() - t0,
      failureMessage,
    };
  } finally {
    await backend.shutdown();
  }
}

// ═══════════════════════════════════════════════════════
// EXECUTE DECISION
// ═══════════════════════════════════════════════════════

/**
 * Execute an actor's decision, persisting changes to the store.
 * Returns the number of posts created (0 or 1).
 */
function executeDecision(
  store: GraphStore,
  runId: string,
  roundNum: number,
  actor: ActorRow,
  routeTier: "A" | "B" | "C",
  decision: DecisionResponse,
  simTimestamp: string,
  actorTopics: string[],
  config: SimConfig
): number {
  switch (decision.action) {
    case "post": {
      const postId = stableId("post", runId, actor.id, String(roundNum));
      const post: Post = {
        id: postId,
        run_id: runId,
        author_id: actor.id,
        content: decision.content ?? `[${actor.handle}] generic post`,
        post_kind: "post",
        round_num: roundNum,
        sim_timestamp: simTimestamp,
        likes: 0,
        reposts: 0,
        comments: 0,
        reach: 0,
        sentiment: actor.sentiment_bias,
      };
      store.addPost(post);
      for (const topic of actorTopics) {
        store.addPostTopic(postId, topic);
      }
      return 1;
    }

    case "comment": {
      const commentId = stableId("comment", runId, actor.id, String(roundNum));
      const comment: Post = {
        id: commentId,
        run_id: runId,
        author_id: actor.id,
        content: decision.content ?? `[${actor.handle}] comment`,
        reply_to: decision.target ?? undefined,
        post_kind: "comment",
        round_num: roundNum,
        sim_timestamp: simTimestamp,
        likes: 0,
        reposts: 0,
        comments: 0,
        reach: 0,
        sentiment: actor.sentiment_bias,
      };
      store.addPost(comment);
      if (decision.target) {
        store.updatePostEngagement(decision.target, "comments", 1);
      }
      return 1;
    }

    case "repost": {
      const repostId = stableId("repost", runId, actor.id, String(roundNum));
      const repost: Post = {
        id: repostId,
        run_id: runId,
        author_id: actor.id,
        content: decision.content ?? `Reposted ${decision.target ?? "post"}`,
        quote_of: decision.target ?? undefined,
        post_kind: "repost",
        round_num: roundNum,
        sim_timestamp: simTimestamp,
        likes: 0,
        reposts: 0,
        comments: 0,
        reach: 0,
        sentiment: actor.sentiment_bias,
      };
      store.addPost(repost);
      if (decision.target) {
        store.updatePostEngagement(decision.target, "reposts", 1);
      }
      return 1;
    }

    case "quote": {
      const quoteId = stableId("quote", runId, actor.id, String(roundNum));
      const quote: Post = {
        id: quoteId,
        run_id: runId,
        author_id: actor.id,
        content: decision.content ?? `[${actor.handle}] quoted a post`,
        quote_of: decision.target ?? undefined,
        post_kind: "quote",
        round_num: roundNum,
        sim_timestamp: simTimestamp,
        likes: 0,
        reposts: 0,
        comments: 0,
        reach: 0,
        sentiment: actor.sentiment_bias,
      };
      store.addPost(quote);
      if (decision.target) {
        store.updatePostEngagement(decision.target, "reposts", 1);
      }
      return 1;
    }

    case "like": {
      if (decision.target) {
        store.addExposure({
          actor_id: actor.id,
          post_id: decision.target,
          round_num: roundNum,
          run_id: runId,
          reaction: "liked",
        });
        store.updatePostEngagement(decision.target, "likes", 1);
      }
      return 0;
    }

    case "unlike": {
      if (decision.target) {
        store.removeLike(actor.id, decision.target, runId);
      }
      return 0;
    }

    case "follow": {
      if (decision.target) {
        store.addFollow({
          follower_id: actor.id,
          following_id: decision.target,
          run_id: runId,
          since_round: roundNum,
        });
      }
      return 0;
    }

    case "unfollow": {
      if (decision.target) {
        store.removeFollow(actor.id, decision.target, runId);
      }
      return 0;
    }

    case "mute": {
      if (decision.target) {
        store.addMute({
          actor_id: actor.id,
          muted_actor_id: decision.target,
          run_id: runId,
          since_round: roundNum,
        });
      }
      return 0;
    }

    case "block": {
      if (decision.target) {
        store.addBlock({
          actor_id: actor.id,
          blocked_actor_id: decision.target,
          run_id: runId,
          since_round: roundNum,
        });
      }
      return 0;
    }

    case "report": {
      if (decision.target) {
        store.addReport({
          id: stableId("report", runId, actor.id, decision.target, String(roundNum)),
          run_id: runId,
          round_num: roundNum,
          reporter_id: actor.id,
          post_id: decision.target,
          reason: decision.reasoning ?? null,
        });
      }
      return 0;
    }

    case "delete": {
      const targetPostId = decision.target ?? stableId("post", runId, actor.id, String(roundNum));
      store.markPostDeleted(targetPostId, actor.id, runId);
      return 0;
    }

    case "idle":
    case "search":
    default:
      return 0;
  }
}

function normalizeDecisionForPlatform(
  config: SimConfig,
  routeTier: "A" | "B" | "C",
  decision: DecisionResponse
): DecisionResponse {
  if (isActionAllowedForTier(config.platform, routeTier, decision.action)) {
    return decision;
  }
  if (decision.action === "search") {
    return { action: "idle", reasoning: decision.reasoning ?? "search handled outside the action loop" };
  }
  const fallbackActions = getAllowedActionsForTier(config.platform, routeTier);
  return {
    action: fallbackActions.includes("idle") ? "idle" : fallbackActions[0] ?? "idle",
    reasoning:
      decision.reasoning ??
      `Action "${decision.action}" is not allowed for tier ${routeTier} on ${config.platform.name}.`,
  };
}

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════

/**
 * Find an actor matching the event's actorArchetype.
 * Returns the first matching actor's ID, or undefined if no match.
 */
function findEventAuthor(
  actors: ActorRow[],
  event: SimEvent
): string | undefined {
  if (!event.actorArchetype) return undefined;
  const match = actors.find((a) => a.archetype === event.actorArchetype);
  return match?.id;
}

function computeSimTimestamp(
  startTime: Date,
  roundNum: number,
  minutesPerRound: number
): string {
  const ms = startTime.getTime() + roundNum * minutesPerRound * 60 * 1000;
  return new Date(ms).toISOString().replace("Z", "").slice(0, 19);
}

function computeSimHour(simTimestamp: string): number {
  const date = new Date(simTimestamp);
  return date.getUTCHours();
}

function persistNarratives(
  store: GraphStore,
  narratives: ReturnType<typeof updateFatigue>["updated"]
): void {
  for (const narrative of narratives) {
    store.updateNarrative(narrative.id, {
      current_intensity: narrative.current_intensity,
      peak_round: narrative.peak_round,
    });
  }
}

function buildActorSnapshotState(store: GraphStore, runId: string) {
  return store.getActorsByRun(runId).map((actor) => ({
    id: actor.id,
    stance: actor.stance,
    sentiment_bias: actor.sentiment_bias,
    activity_level: actor.activity_level,
    influence_weight: actor.influence_weight,
    follower_count: actor.follower_count,
    following_count: actor.following_count,
  }));
}

function buildNarrativeSnapshotState(narratives: ReturnType<typeof updateFatigue>["updated"]) {
  return narratives.map((narrative) => ({
    topic: narrative.topic,
    currentIntensity: narrative.current_intensity,
    totalPosts: narrative.total_posts,
    dominantSentiment: narrative.dominant_sentiment,
    peakRound: narrative.peak_round,
  }));
}
