/**
 * events.ts — Event injection: initial posts, scheduled events, threshold triggers
 *
 * Source of truth: PLAN.md §events.ts, CLAUDE.md Phase 6
 *
 * Pure function. Evaluates conditions against PlatformState to produce
 * SimEvent[] for the current round. Engine.ts calls processEvents()
 * at the TOP of each round, BEFORE activation and cognition routing,
 * so events affect the current round immediately.
 *
 * Threshold conditions use "topic" as a variable — the evaluator
 * iterates all observed topics and returns which concrete topics
 * satisfied the condition.
 */

import type { SimEvent, PlatformState, PostSnapshot } from "./db.js";
import type { EventConfig, ThresholdTrigger } from "./config.js";

// ═══════════════════════════════════════════════════════
// PROCESS EVENTS
// ═══════════════════════════════════════════════════════

/**
 * Produce events for the current round.
 *
 * 1. Initial posts (round 0 only)
 * 2. Scheduled events (matching round number)
 * 3. Threshold triggers (conditions evaluated against state)
 */
/**
 * @param firedTriggers — conditions already fired in previous rounds.
 *   Prevents threshold triggers from re-firing every round while the
 *   condition remains true. Engine.ts maintains this set across rounds.
 */
export function processEvents(
  roundNum: number,
  config: EventConfig,
  state: PlatformState,
  firedTriggers?: Set<string>
): SimEvent[] {
  const events: SimEvent[] = [];

  // 1. Initial posts (round 0)
  if (roundNum === 0) {
    for (const post of config.initialPosts) {
      events.push({
        type: "initial_post",
        round: 0,
        content: post.content,
        topics: post.topics,
        actorArchetype: post.actorArchetype,
        actor_id: undefined,
      });
    }
  }

  // 2. Scheduled events
  for (const scheduled of config.scheduled) {
    if (scheduled.round === roundNum) {
      events.push({
        type: "scheduled",
        round: roundNum,
        content: scheduled.content,
        topics: scheduled.topics,
        actorArchetype: scheduled.actorArchetype,
        actor_id: undefined,
      });
    }
  }

  // 3. Threshold triggers (fire-once: skip if already fired)
  for (const trigger of config.thresholdTriggers) {
    if (firedTriggers?.has(trigger.condition)) continue;

    const { fired, matchedTopics } = evaluateCondition(
      trigger.condition,
      state
    );
    if (fired) {
      firedTriggers?.add(trigger.condition);
      events.push({
        type: "threshold_trigger",
        round: roundNum,
        content: trigger.event,
        topics: matchedTopics,
        actorArchetype: trigger.actorArchetype,
        actor_id: undefined,
      });
    }
  }

  return events;
}

// ═══════════════════════════════════════════════════════
// CONDITION EVALUATOR
// ═══════════════════════════════════════════════════════

/**
 * Evaluate a threshold condition against observed topics.
 *
 * "topic" in the condition string is a variable — the evaluator
 * computes the metric for every distinct topic in recentPosts
 * and returns which concrete topics matched.
 *
 * Supported conditions:
 *   avgSentiment(topic) < N
 *   avgSentiment(topic) > N
 *   postCount(topic) < N
 *   postCount(topic) > N
 */
export function evaluateCondition(
  condition: string,
  state: PlatformState
): { fired: boolean; matchedTopics: string[] } {
  const parsed = parseCondition(condition);
  if (!parsed) {
    return { fired: false, matchedTopics: [] };
  }

  const { metric, operator, threshold } = parsed;

  // Collect all distinct topics from recent posts
  const topicPosts = new Map<string, PostSnapshot[]>();
  for (const post of state.recentPosts) {
    for (const topic of post.topics) {
      let posts = topicPosts.get(topic);
      if (!posts) {
        posts = [];
        topicPosts.set(topic, posts);
      }
      posts.push(post);
    }
  }

  const matchedTopics: string[] = [];

  for (const [topic, posts] of topicPosts) {
    const value = computeMetric(metric, posts);
    if (compare(value, operator, threshold)) {
      matchedTopics.push(topic);
    }
  }

  return {
    fired: matchedTopics.length > 0,
    matchedTopics,
  };
}

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════

interface ParsedCondition {
  metric: "avgSentiment" | "postCount";
  operator: "<" | ">";
  threshold: number;
}

const CONDITION_REGEX =
  /^(avgSentiment|postCount)\(topic\)\s*([<>])\s*(-?\d+\.?\d*)$/;

function parseCondition(condition: string): ParsedCondition | null {
  const match = condition.match(CONDITION_REGEX);
  if (!match) return null;

  return {
    metric: match[1] as "avgSentiment" | "postCount",
    operator: match[2] as "<" | ">",
    threshold: parseFloat(match[3]),
  };
}

function computeMetric(
  metric: "avgSentiment" | "postCount",
  posts: PostSnapshot[]
): number {
  if (posts.length === 0) return 0;

  switch (metric) {
    case "avgSentiment": {
      const sum = posts.reduce((acc, p) => acc + p.sentiment, 0);
      return sum / posts.length;
    }
    case "postCount":
      return posts.length;
  }
}

function compare(value: number, operator: "<" | ">", threshold: number): boolean {
  return operator === "<" ? value < threshold : value > threshold;
}
