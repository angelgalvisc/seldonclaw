/**
 * fatigue.ts — Narrative fatigue: exponential decay + extinction + re-activation
 *
 * Source of truth: PLAN.md §fatigue.ts, CLAUDE.md Phase 6
 *
 * Pure functions — no DB dependency. Operates on NarrativeRow[] in-memory.
 * Engine.ts calls updateFatigue() per round to decay intensities,
 * and computeFatiguePenalty() is used by activation.ts to reduce
 * activation probability for actors discussing exhausted topics.
 */

import type { NarrativeRow } from "./db.js";
import type { FatigueConfig } from "./config.js";

// ═══════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════

export interface FatigueResult {
  /** All narratives with updated current_intensity */
  updated: NarrativeRow[];
  /** Topic names that fell below extinctionThreshold */
  extinct: string[];
}

// ═══════════════════════════════════════════════════════
// UPDATE FATIGUE
// ═══════════════════════════════════════════════════════

/**
 * Apply exponential decay to narrative intensities.
 *
 * intensity = exp(-decayRate × age)
 * where age = roundNum - first_round
 *
 * Narratives below extinctionThreshold are reported as extinct.
 * Does NOT handle re-activation — engine.ts does that after
 * comparing with events.ts output.
 */
export function updateFatigue(
  narratives: NarrativeRow[],
  roundNum: number,
  config: FatigueConfig
): FatigueResult {
  const extinct: string[] = [];
  const updated: NarrativeRow[] = [];

  for (const narrative of narratives) {
    const age = roundNum - (narrative.first_round ?? 0);
    const intensity = Math.exp(-config.decayRate * age);

    const copy: NarrativeRow = {
      ...narrative,
      current_intensity: intensity,
    };

    // Track peak: if current intensity exceeds what was the peak level
    // and peak hasn't been set yet, this is the initial peak
    if (copy.peak_round === null && age > 0) {
      copy.peak_round = narrative.first_round ?? 0;
    }

    if (intensity < config.extinctionThreshold) {
      extinct.push(narrative.topic);
    }

    updated.push(copy);
  }

  return { updated, extinct };
}

// ═══════════════════════════════════════════════════════
// FATIGUE PENALTY (for activation.ts)
// ═══════════════════════════════════════════════════════

/**
 * Compute fatigue penalty for an actor based on their topics'
 * narrative intensities.
 *
 * penalty = penaltyWeight × (1 - avgIntensity)
 *
 * Returns a negative number (penaltyWeight is negative, e.g. -0.3).
 * When topics are fresh (avgIntensity ≈ 1.0) → penalty ≈ 0.
 * When topics are extinct (avgIntensity ≈ 0.0) → penalty ≈ penaltyWeight.
 * When actor has no matching narratives → penalty = 0 (no fatigue).
 */
export function computeFatiguePenalty(
  actorTopics: string[],
  narratives: NarrativeRow[],
  penaltyWeight: number
): number {
  if (actorTopics.length === 0 || narratives.length === 0) return 0;

  const topicSet = new Set(actorTopics);
  const matching = narratives.filter((n) => topicSet.has(n.topic));

  if (matching.length === 0) return 0;

  const avgIntensity =
    matching.reduce((sum, n) => sum + n.current_intensity, 0) / matching.length;

  return penaltyWeight * (1 - avgIntensity);
}
