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
  SimEvent,
} from "./db.js";
import type { SimConfig } from "./config.js";
import type { CognitionBackend, DecisionResponse } from "./cognition.js";
import { deriveActivationConfig, totalRounds, sanitizeForStorage } from "./config.js";
import { computeActivation } from "./activation.js";
import { buildFeed } from "./feed.js";
import {
  routeCognition,
  applyTierCRules,
  buildDecisionRequest,
  buildSimContext,
} from "./cognition.js";
import { logAction, updateRound } from "./telemetry.js";
import { SeedablePRNG, saveSnapshot } from "./reproducibility.js";
import { stableId, uuid } from "./db.js";
import { processEvents } from "./events.js";
import { propagate } from "./propagation.js";
import { updateFatigue } from "./fatigue.js";

// ═══════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════

export interface EngineResult {
  runId: string;
  totalRounds: number;
  status: "completed" | "failed";
  wallTimeMs: number;
}

export interface EngineOptions {
  store: GraphStore;
  config: SimConfig;
  backend: CognitionBackend;
  runId?: string;
}

// ═══════════════════════════════════════════════════════
// MAIN SIMULATION LOOP
// ═══════════════════════════════════════════════════════

export async function runSimulation(opts: EngineOptions): Promise<EngineResult> {
  const { store, config, backend } = opts;
  const t0 = Date.now();
  const numRounds = totalRounds(config);
  const runId = opts.runId ?? uuid();

  // 1. Initialize
  const rng = new SeedablePRNG(config.simulation.seed);
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

  // Simulation start time (round 0 = 2024-01-01T00:00:00 in configured timezone)
  const startTime = new Date("2024-01-01T00:00:00");

  try {
    // 2. Per-round loop
    for (let roundNum = 0; roundNum < numRounds; roundNum++) {
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
      const activeEvents = processEvents(roundNum, config.events, state);

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
        store.updateNarrative(narrative.id, {
          current_intensity: narrative.current_intensity,
          peak_round: narrative.peak_round,
        });
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

      // Per-actor processing
      let totalPosts = 0;
      let totalActions = 0;
      let tierACalls = 0;
      let tierBCalls = 0;
      let tierCActions = 0;

      for (const actor of activeActors) {
        // Build feed
        const actorTopics = actorTopicsMap.get(actor.id) ?? [];
        const feed = buildFeed(actor, state, config.feed, actorTopics);

        // Route cognition
        const route = routeCognition(
          actor,
          feed,
          config.cognition,
          rng,
          activeEvents,
          actorTopics
        );

        // Decide
        let decision: DecisionResponse;
        if (route.tier === "C") {
          decision = applyTierCRules(actor, feed, config.cognition, rng);
          tierCActions++;
        } else {
          const beliefs = actorBeliefsMap.get(actor.id) ?? {};
          const simContext = buildSimContext(
            actor,
            store,
            runId,
            roundNum,
            config.cognition.interactionLookback
          );
          const request = buildDecisionRequest(
            actor,
            feed,
            beliefs,
            actorTopics,
            simContext,
            roundNum
          );
          decision = await backend.decide(request);

          if (route.tier === "A") tierACalls++;
          else tierBCalls++;
        }

        // Execute decision
        const postsCreated = executeDecision(
          store,
          runId,
          roundNum,
          actor,
          decision,
          simTimestamp,
          actorTopics
        );
        totalPosts += postsCreated;
        totalActions++;

        // Log telemetry
        logAction(
          store,
          runId,
          roundNum,
          actor.id,
          route.tier,
          decision.action,
          JSON.stringify(decision)
        );
      }

      // ── Phase 6: Propagation (AFTER execute, spreads previous rounds' posts) ──
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
        wallTimeMs: roundWallTimeMs,
      });

      // Snapshot
      if (
        config.simulation.snapshotEvery > 0 &&
        roundNum > 0 &&
        roundNum % config.simulation.snapshotEvery === 0
      ) {
        const actorStates = store.getActorsByRun(runId).map((actor) => ({
          id: actor.id,
          stance: actor.stance,
          sentiment_bias: actor.sentiment_bias,
          activity_level: actor.activity_level,
          influence_weight: actor.influence_weight,
          follower_count: actor.follower_count,
          following_count: actor.following_count,
        }));
        const narrativeStates = store.getNarrativesByRun(runId).map((narrative) => ({
          topic: narrative.topic,
          currentIntensity: narrative.current_intensity,
          totalPosts: narrative.total_posts,
          dominantSentiment: narrative.dominant_sentiment,
          peakRound: narrative.peak_round,
        }));

        saveSnapshot(store, runId, roundNum, actorStates, narrativeStates, rng);
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
      status: "completed",
      wallTimeMs: Date.now() - t0,
    };
  } catch (err) {
    store.updateRun(runId, {
      status: "failed",
      finished_at: new Date().toISOString(),
    });

    return {
      runId,
      totalRounds: numRounds,
      status: "failed",
      wallTimeMs: Date.now() - t0,
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
  decision: DecisionResponse,
  simTimestamp: string,
  actorTopics: string[]
): number {
  switch (decision.action) {
    case "post": {
      const postId = stableId("post", runId, actor.id, String(roundNum));
      const post: Post = {
        id: postId,
        run_id: runId,
        author_id: actor.id,
        content: decision.content ?? `[${actor.handle}] generic post`,
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
        content: decision.content ?? `RT @${decision.target ?? "unknown"}`,
        quote_of: decision.target ?? undefined,
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

    case "idle":
    case "search":
    default:
      return 0;
  }
}

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════

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
