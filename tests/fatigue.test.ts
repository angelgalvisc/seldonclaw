/**
 * fatigue.test.ts — Tests for narrative fatigue decay + penalty
 *
 * Covers:
 * - Exponential decay of narrative intensity
 * - Extinction when below threshold
 * - Zero age → intensity 1.0
 * - Empty narratives → no-op
 * - Penalty: fresh topic → 0, extinct topic → penaltyWeight
 * - Penalty: multiple topics → average intensity
 * - Penalty: no matching narratives → 0
 */

import { describe, it, expect } from "vitest";
import { updateFatigue, computeFatiguePenalty } from "../src/fatigue.js";
import type { NarrativeRow } from "../src/db.js";
import type { FatigueConfig } from "../src/config.js";

// ═══════════════════════════════════════════════════════
// FIXTURES
// ═══════════════════════════════════════════════════════

const defaultConfig: FatigueConfig = {
  decayRate: 0.05,
  extinctionThreshold: 0.1,
  reactivationBoost: 0.6,
};

function makeNarrative(overrides: Partial<NarrativeRow> = {}): NarrativeRow {
  return {
    id: "n-1",
    run_id: "run-1",
    topic: "education",
    first_round: 0,
    peak_round: null,
    current_intensity: 1.0,
    total_posts: 10,
    dominant_sentiment: -0.5,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════
// updateFatigue
// ═══════════════════════════════════════════════════════

describe("updateFatigue — decay", () => {
  it("intensity decays exponentially over rounds", () => {
    const narrative = makeNarrative({ first_round: 0 });
    const r5 = updateFatigue([narrative], 5, defaultConfig);
    const r10 = updateFatigue([narrative], 10, defaultConfig);
    const r20 = updateFatigue([narrative], 20, defaultConfig);

    // exp(-0.05 * 5) ≈ 0.778, exp(-0.05 * 10) ≈ 0.607, exp(-0.05 * 20) ≈ 0.368
    expect(r5.updated[0].current_intensity).toBeCloseTo(Math.exp(-0.05 * 5), 5);
    expect(r10.updated[0].current_intensity).toBeCloseTo(Math.exp(-0.05 * 10), 5);
    expect(r20.updated[0].current_intensity).toBeCloseTo(Math.exp(-0.05 * 20), 5);

    // Monotonic decrease
    expect(r5.updated[0].current_intensity).toBeGreaterThan(r10.updated[0].current_intensity);
    expect(r10.updated[0].current_intensity).toBeGreaterThan(r20.updated[0].current_intensity);
  });

  it("zero age → intensity 1.0", () => {
    const narrative = makeNarrative({ first_round: 5 });
    const result = updateFatigue([narrative], 5, defaultConfig);
    // age = 5 - 5 = 0, exp(0) = 1.0
    expect(result.updated[0].current_intensity).toBe(1.0);
  });

  it("first_round null treated as 0", () => {
    const narrative = makeNarrative({ first_round: null });
    const result = updateFatigue([narrative], 10, defaultConfig);
    expect(result.updated[0].current_intensity).toBeCloseTo(Math.exp(-0.05 * 10), 5);
  });
});

describe("updateFatigue — extinction", () => {
  it("marks topic extinct when below threshold", () => {
    const narrative = makeNarrative({ first_round: 0, topic: "tuition" });
    // exp(-0.05 * 50) ≈ 0.082 < 0.1
    const result = updateFatigue([narrative], 50, defaultConfig);

    expect(result.extinct).toContain("tuition");
    expect(result.updated[0].current_intensity).toBeLessThan(defaultConfig.extinctionThreshold);
  });

  it("does not mark extinct when above threshold", () => {
    const narrative = makeNarrative({ first_round: 0, topic: "tuition" });
    // exp(-0.05 * 10) ≈ 0.607 > 0.1
    const result = updateFatigue([narrative], 10, defaultConfig);

    expect(result.extinct).not.toContain("tuition");
  });

  it("uses exact threshold boundary", () => {
    // Find the round where intensity ≈ extinctionThreshold
    // exp(-0.05 * r) = 0.1 → r = -ln(0.1) / 0.05 ≈ 46.05
    const narrative = makeNarrative({ first_round: 0 });

    const justAbove = updateFatigue([narrative], 45, defaultConfig);
    const justBelow = updateFatigue([narrative], 47, defaultConfig);

    expect(justAbove.extinct).toHaveLength(0);
    expect(justBelow.extinct).toHaveLength(1);
  });
});

describe("updateFatigue — edge cases", () => {
  it("empty narratives → empty result", () => {
    const result = updateFatigue([], 10, defaultConfig);
    expect(result.updated).toHaveLength(0);
    expect(result.extinct).toHaveLength(0);
  });

  it("multiple narratives processed independently", () => {
    const n1 = makeNarrative({ id: "n-1", topic: "tuition", first_round: 0 });
    const n2 = makeNarrative({ id: "n-2", topic: "campus", first_round: 40 });

    // At round 50: tuition age=50 (extinct), campus age=10 (alive)
    const result = updateFatigue([n1, n2], 50, defaultConfig);

    expect(result.extinct).toContain("tuition");
    expect(result.extinct).not.toContain("campus");
    expect(result.updated[0].current_intensity).toBeLessThan(0.1);
    expect(result.updated[1].current_intensity).toBeGreaterThan(0.5);
  });

  it("does not mutate input narratives", () => {
    const narrative = makeNarrative({ current_intensity: 1.0 });
    updateFatigue([narrative], 20, defaultConfig);
    expect(narrative.current_intensity).toBe(1.0);
  });

  it("higher decay rate produces faster extinction", () => {
    const narrative = makeNarrative({ first_round: 0 });
    const fast = updateFatigue([narrative], 10, { ...defaultConfig, decayRate: 0.2 });
    const slow = updateFatigue([narrative], 10, { ...defaultConfig, decayRate: 0.02 });

    expect(fast.updated[0].current_intensity).toBeLessThan(slow.updated[0].current_intensity);
  });
});

// ═══════════════════════════════════════════════════════
// computeFatiguePenalty
// ═══════════════════════════════════════════════════════

describe("computeFatiguePenalty", () => {
  const penaltyWeight = -0.3;

  it("fresh topic → penalty ≈ 0", () => {
    const narratives = [makeNarrative({ topic: "edu", current_intensity: 1.0 })];
    const penalty = computeFatiguePenalty(["edu"], narratives, penaltyWeight);
    expect(penalty).toBeCloseTo(0, 5);
  });

  it("extinct topic → penalty ≈ penaltyWeight", () => {
    const narratives = [makeNarrative({ topic: "edu", current_intensity: 0.0 })];
    const penalty = computeFatiguePenalty(["edu"], narratives, penaltyWeight);
    expect(penalty).toBeCloseTo(penaltyWeight, 5);
  });

  it("half-decayed topic → penalty ≈ penaltyWeight/2", () => {
    const narratives = [makeNarrative({ topic: "edu", current_intensity: 0.5 })];
    const penalty = computeFatiguePenalty(["edu"], narratives, penaltyWeight);
    expect(penalty).toBeCloseTo(penaltyWeight * 0.5, 5);
  });

  it("multiple topics → average intensity", () => {
    const narratives = [
      makeNarrative({ id: "n-1", topic: "edu", current_intensity: 1.0 }),
      makeNarrative({ id: "n-2", topic: "sports", current_intensity: 0.0 }),
    ];
    const penalty = computeFatiguePenalty(["edu", "sports"], narratives, penaltyWeight);
    // avg intensity = 0.5 → penalty = -0.3 * 0.5 = -0.15
    expect(penalty).toBeCloseTo(penaltyWeight * 0.5, 5);
  });

  it("no matching narratives → 0", () => {
    const narratives = [makeNarrative({ topic: "sports", current_intensity: 0.0 })];
    const penalty = computeFatiguePenalty(["edu"], narratives, penaltyWeight);
    expect(penalty).toBe(0);
  });

  it("empty actor topics → 0", () => {
    const narratives = [makeNarrative({ topic: "edu", current_intensity: 0.0 })];
    const penalty = computeFatiguePenalty([], narratives, penaltyWeight);
    expect(penalty).toBe(0);
  });

  it("empty narratives → 0", () => {
    const penalty = computeFatiguePenalty(["edu"], [], penaltyWeight);
    expect(penalty).toBe(0);
  });
});
