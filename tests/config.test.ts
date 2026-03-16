/**
 * config.test.ts — Verification for Step 1.2 (config.ts)
 *
 * Ref: CLAUDE.md §Step 1.2 verification criteria
 * - Loads example config from PLAN.md
 * - sanitizeForStorage() removes apiKeyEnv values
 * - Invalid config (negative seed, probability > 1) → descriptive error
 * - Default config has all required fields
 */

import { describe, it, expect } from "vitest";
import {
  parseConfig,
  defaultConfig,
  sanitizeForStorage,
  totalRounds,
  deriveActivationConfig,
  ConfigError,
} from "../src/config.js";

describe("config.ts", () => {
  // ─── Default config ───

  describe("defaultConfig", () => {
    it("returns a complete config with all required fields", () => {
      const config = defaultConfig();

      expect(config.simulation.platform).toBe("x");
      expect(config.simulation.totalHours).toBe(72);
      expect(config.simulation.minutesPerRound).toBe(60);
      expect(config.simulation.timezone).toBe("America/Bogota");
      expect(config.simulation.timeAccelerationMode).toBe("off");
      expect(config.simulation.maxFastForwardRounds).toBe(24);
      expect(config.simulation.seed).toBe(42);
      expect(config.simulation.peakHours).toContain(9);
      expect(config.simulation.offPeakHours).toContain(3);

      expect(config.cognition.tierA.minInfluence).toBe(0.8);
      expect(config.cognition.tierB.samplingRate).toBe(0.3);
      expect(config.cognition.tierC.repostProb).toBe(0.4);
      expect(config.cognition.tierC.likeProb).toBe(0.6);
      expect(config.cognition.interactionLookback).toBe(5);

      expect(config.providers.analysis.sdk).toBe("anthropic");
      expect(config.providers.analysis.model).toBe("claude-sonnet-4-20250514");

      expect(config.feed.size).toBe(20);
      expect(config.feed.recencyWeight + config.feed.popularityWeight + config.feed.relevanceWeight).toBeCloseTo(1.0);
      expect(config.feed.embeddingEnabled).toBe(false);
      expect(config.feed.embeddingModel).toBe("hash-embedding-v1");
      expect(config.feed.embeddingDimensions).toBe(32);
      expect(config.search.enabled).toBe(false);
      expect(config.search.endpoint).toBe("http://localhost:8888");
      expect(config.search.enabledTiers).toEqual(["A", "B"]);
      expect(config.search.maxActorsPerRound).toBe(4);
      expect(config.search.maxActorsByTier).toEqual({ A: 2, B: 2 });
      expect(config.search.maxResultsPerQuery).toBe(5);
      expect(config.platform.name).toBe("x");
      expect(config.platform.actions).toContain("quote");
      expect(config.platform.tierAllowedActions.A).toContain("block");
      expect(config.platform.recsys).toBe("hybrid");
      expect(config.feed.algorithm).toBe("hybrid");
      expect(config.feed.traceWeight).toBe(0.25);
      expect(config.feed.outOfNetworkRatio).toBe(0.35);
      expect(config.feed.diversityWeight).toBe(0.2);

      expect(config.propagation.viralThreshold).toBe(30);
      expect(config.fatigue.decayRate).toBe(0.05);
    });
  });

  // ─── YAML parsing ───

  describe("parseConfig", () => {
    it("loads and merges partial YAML config with defaults", () => {
      const yaml = `
simulation:
  seed: 123
  totalHours: 24

cognition:
  tierA:
    minInfluence: 0.9
`;
      const config = parseConfig(yaml);

      // Overridden values
      expect(config.simulation.seed).toBe(123);
      expect(config.simulation.totalHours).toBe(24);
      expect(config.cognition.tierA.minInfluence).toBe(0.9);

      // Defaults preserved
      expect(config.simulation.platform).toBe("x");
      expect(config.simulation.minutesPerRound).toBe(60);
      expect(config.cognition.tierB.samplingRate).toBe(0.3);
      expect(config.feed.size).toBe(20);
    });

    it("loads full PLAN.md example config", () => {
      const yaml = `
simulation:
  platform: "x"
  totalHours: 72
  minutesPerRound: 60
  timezone: "America/Bogota"
  concurrency: 1
  seed: 42
  snapshotEvery: 10
  peakHours: [8, 9, 10, 12, 13, 19, 20, 21, 22]
  offPeakHours: [0, 1, 2, 3, 4, 5, 6]

cognition:
  tierA:
    minInfluence: 0.8
    archetypeOverrides: ["institution", "media"]
  tierB:
    samplingRate: 0.3
  tierC:
    repostProb: 0.4
    likeProb: 0.6
  interactionLookback: 5

providers:
  analysis:
    sdk: "anthropic"
    model: "claude-sonnet-4-20250514"
    apiKeyEnv: "ANTHROPIC_API_KEY"
  generation:
    sdk: "anthropic"
    model: "claude-sonnet-4-20250514"
    apiKeyEnv: "ANTHROPIC_API_KEY"
  simulation:
    model: "claude-haiku-4-20250414"
    apiKeyEnv: "ANTHROPIC_API_KEY"
  report:
    sdk: "anthropic"
    model: "claude-sonnet-4-20250514"
    apiKeyEnv: "ANTHROPIC_API_KEY"

feed:
  size: 20
  recencyWeight: 0.4
  popularityWeight: 0.3
  relevanceWeight: 0.3
  echoChamberStrength: 0.5
  embeddingEnabled: false
  embeddingWeight: 0.25
  embeddingModel: "hash-embedding-v1"
  embeddingDimensions: 32

search:
  enabled: false
  endpoint: "http://localhost:8888"
  cutoffDate: "2026-03-01"
  strictCutoff: true
  enabledTiers: ["A", "B"]
  maxActorsPerRound: 4
  maxActorsByTier:
    A: 2
    B: 2
  allowArchetypes: ["media"]
  denyArchetypes: []
  allowProfessions: ["journalist"]
  denyProfessions: []
  allowActors: []
  denyActors: []
  maxResultsPerQuery: 5
  maxQueriesPerActor: 2
  categories: "news"
  defaultLanguage: "auto"
  timeoutMs: 3000

propagation:
  viralThreshold: 30
  crossCommunityDecay: 0.7
  influenceMultiplier: 1.5

fatigue:
  decayRate: 0.05
  extinctionThreshold: 0.1
  reactivationBoost: 0.6

events:
  initialPosts: []
  scheduled: []
  thresholdTriggers:
    - condition: "avgSentiment(topic) < -0.6"
      event: "Institutional response statement"
      actorArchetype: "institution"

output:
  dir: "./output"
  format: "both"
`;
      const config = parseConfig(yaml);
      expect(config.simulation.platform).toBe("x");
      expect(config.simulation.timezone).toBe("America/Bogota");
      expect(config.cognition.tierA.archetypeOverrides).toContain("media");
      expect(config.search.cutoffDate).toBe("2026-03-01");
      expect(config.search.allowArchetypes).toEqual(["media"]);
    });
  });

  // ─── Validation ───

  describe("validation", () => {
    it("rejects negative seed", () => {
      expect(() => {
        parseConfig(`
simulation:
  seed: -1
`);
      }).toThrow(ConfigError);
    });

    it("rejects probability > 1", () => {
      expect(() => {
        parseConfig(`
cognition:
  tierC:
    repostProb: 1.5
`);
      }).toThrow(ConfigError);
    });

    it("rejects probability < 0", () => {
      expect(() => {
        parseConfig(`
cognition:
  tierB:
    samplingRate: -0.1
`);
      }).toThrow(ConfigError);
    });

    it("rejects zero totalHours", () => {
      expect(() => {
        parseConfig(`
simulation:
  totalHours: 0
`);
      }).toThrow(ConfigError);
    });

    it("rejects concurrency < 1", () => {
      expect(() => {
        parseConfig(`
simulation:
  concurrency: 0
`);
      }).toThrow(ConfigError);
    });

    it("rejects invalid timeAccelerationMode", () => {
      expect(() => {
        parseConfig(`
simulation:
  timeAccelerationMode: "warp"
`);
      }).toThrow(ConfigError);
    });

    it("rejects maxFastForwardRounds < 1", () => {
      expect(() => {
        parseConfig(`
simulation:
  maxFastForwardRounds: 0
`);
      }).toThrow(ConfigError);
    });

    it("rejects interactionLookback < 1", () => {
      expect(() => {
        parseConfig(`
cognition:
  interactionLookback: 0
`);
      }).toThrow(ConfigError);
    });

    it("rejects feed weights that don't sum to 1", () => {
      expect(() => {
        parseConfig(`
feed:
  recencyWeight: 0.5
  popularityWeight: 0.5
  relevanceWeight: 0.5
`);
      }).toThrow(ConfigError);
    });

    it("rejects search tiers outside A/B", () => {
      expect(() => {
        parseConfig(`
search:
  enabledTiers: ["A", "C"]
`);
      }).toThrow(ConfigError);
    });

    it("rejects invalid search endpoint when enabled", () => {
      expect(() => {
        parseConfig(`
search:
  enabled: true
  endpoint: "localhost:8888"
`);
      }).toThrow(ConfigError);
    });

    it("rejects tier actions not enabled by the platform", () => {
      expect(() => {
        parseConfig(`
platform:
  actions: ["post", "idle"]
  tierAllowedActions:
    A: ["post", "block", "idle"]
    B: ["post", "idle"]
    C: ["idle"]
`);
      }).toThrow(ConfigError);
    });

    it("rejects invalid cutoffDate", () => {
      expect(() => {
        parseConfig(`
search:
  cutoffDate: "not-a-date"
`);
      }).toThrow(ConfigError);
    });

    it("rejects negative search budgets", () => {
      expect(() => {
        parseConfig(`
search:
  maxActorsPerRound: -1
`);
      }).toThrow(ConfigError);
    });

    it("rejects embeddingWeight > 1", () => {
      expect(() => {
        parseConfig(`
feed:
  embeddingWeight: 1.5
`);
      }).toThrow(ConfigError);
    });

    it("ConfigError includes field name", () => {
      try {
        parseConfig(`
simulation:
  seed: -1
`);
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        expect((e as ConfigError).field).toBe("simulation.seed");
      }
    });
  });

  // ─── sanitizeForStorage ───

  describe("sanitizeForStorage", () => {
    it("redacts apiKeyEnv values", () => {
      const config = defaultConfig();
      const sanitized = sanitizeForStorage(config);
      const parsed = JSON.parse(sanitized);

      expect(parsed.providers.analysis.apiKeyEnv).toBe("[REDACTED]");
      expect(parsed.providers.generation.apiKeyEnv).toBe("[REDACTED]");
      expect(parsed.providers.simulation.apiKeyEnv).toBe("[REDACTED]");
      expect(parsed.providers.report.apiKeyEnv).toBe("[REDACTED]");
    });

    it("does not modify the original config", () => {
      const config = defaultConfig();
      sanitizeForStorage(config);

      // Original should be unchanged
      expect(config.providers.analysis.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
    });
  });

  // ─── Helpers ───

  describe("helpers", () => {
    it("totalRounds computes correctly", () => {
      const config = defaultConfig();
      // 72 hours, 60 min/round = 72 rounds
      expect(totalRounds(config)).toBe(72);
    });

    it("totalRounds handles non-even division", () => {
      const config = defaultConfig();
      config.simulation.totalHours = 10;
      config.simulation.minutesPerRound = 45;
      // 600 min / 45 min = 13.33 → ceil = 14
      expect(totalRounds(config)).toBe(14);
    });

    it("deriveActivationConfig returns proper defaults", () => {
      const config = defaultConfig();
      const activation = deriveActivationConfig(config);

      expect(activation.peakHours).toEqual(config.simulation.peakHours);
      expect(activation.offPeakHours).toEqual(config.simulation.offPeakHours);
      expect(activation.peakHourMultiplier).toBe(1.5);
      expect(activation.offPeakMultiplier).toBe(0.3);
      expect(activation.eventBoostMultiplier).toBe(2.0);
      expect(activation.fatiguePenaltyWeight).toBe(-0.3);
    });
  });
});
