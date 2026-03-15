/**
 * activation.ts — Actor activation per round
 *
 * Source of truth: PLAN.md §activation.ts (lines 829-863),
 *                  CLAUDE.md Phase 4.1
 *
 * Determines which actors "come online" each round using:
 * - base probability from activity_level
 * - hour multiplier (peak/off-peak/actor active hours)
 * - event boost (topic overlap with active events)
 * - fatigue penalty (stub until Phase 6)
 *
 * All decisions use the seeded PRNG for determinism.
 */

import type { ActorRow, RoundContext, SimEvent, NarrativeRow } from "./db.js";
import type { ActivationConfig } from "./config.js";
import { computeFatiguePenalty } from "./fatigue.js";

// ═══════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════

export interface ActivationResult {
  activeActors: ActorRow[];
  reasons: Map<string, string>;
}

// ═══════════════════════════════════════════════════════
// COMPUTE ACTIVATION
// ═══════════════════════════════════════════════════════

/**
 * Determine which actors activate in a given round.
 *
 * Actors are processed in deterministic order (sorted by id).
 * Each actor consumes exactly one rng.next() call regardless of
 * whether they activate, ensuring reproducible sequences.
 */
export function computeActivation(
  actors: ActorRow[],
  round: RoundContext,
  config: ActivationConfig,
  actorTopicsMap?: Map<string, string[]>,
  narratives?: NarrativeRow[]
): ActivationResult {
  const sorted = [...actors].sort((a, b) => a.id.localeCompare(b.id));

  const activeActors: ActorRow[] = [];
  const reasons = new Map<string, string>();

  for (const actor of sorted) {
    const baseProb = actor.activity_level;

    // Hour multiplier
    const actorHours = parseJsonArray(actor.active_hours);
    const hourMult = getHourMultiplier(
      round.simHour,
      actorHours,
      config.peakHours,
      config.offPeakHours,
      config.peakHourMultiplier,
      config.offPeakMultiplier
    );

    // Event boost
    const topics = actorTopicsMap?.get(actor.id) ?? [];
    const eventBoost = hasRelevantEvent(round.activeEvents, topics)
      ? config.eventBoostMultiplier
      : 1.0;

    // Fatigue penalty — reduces activation for actors on exhausted topics
    const fatiguePenalty = narratives
      ? computeFatiguePenalty(topics, narratives, config.fatiguePenaltyWeight)
      : 0;

    const finalProb = clamp01(
      baseProb * hourMult * eventBoost + fatiguePenalty
    );

    // Always consume one RNG call per actor for determinism
    const roll = round.rng.next();
    const activated = roll < finalProb;

    if (activated) {
      activeActors.push(actor);

      const parts: string[] = [];
      if (hourMult > 1.0) parts.push(`peak_hour(${hourMult})`);
      else if (hourMult < 1.0) parts.push(`off_peak(${hourMult})`);
      if (eventBoost > 1.0) parts.push(`event_boost(${eventBoost})`);
      parts.push(`prob=${finalProb.toFixed(2)}`);
      reasons.set(actor.id, parts.join(" "));
    }
  }

  return { activeActors, reasons };
}

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════

/**
 * Get the hour multiplier for activation probability.
 * Priority: actor's own active_hours > global peak/off-peak > neutral (1.0).
 */
function getHourMultiplier(
  simHour: number,
  actorActiveHours: number[],
  peakHours: number[],
  offPeakHours: number[],
  peakMultiplier: number,
  offPeakMultiplier: number
): number {
  // Actor-specific active hours take priority
  if (actorActiveHours.length > 0 && actorActiveHours.includes(simHour)) {
    return peakMultiplier;
  }

  // Global peak hours
  if (peakHours.includes(simHour)) {
    return peakMultiplier;
  }

  // Off-peak suppression
  if (offPeakHours.includes(simHour)) {
    return offPeakMultiplier;
  }

  // Neutral hour
  return 1.0;
}

/**
 * Check if any active event has topic overlap with the actor's topics.
 */
function hasRelevantEvent(
  events: SimEvent[],
  actorTopics: string[]
): boolean {
  if (events.length === 0 || actorTopics.length === 0) return false;

  const topicSet = new Set(actorTopics);
  return events.some(
    (e) => e.topics?.some((t) => topicSet.has(t)) ?? false
  );
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function parseJsonArray(json: string | null): number[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
