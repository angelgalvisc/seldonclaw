/**
 * config.ts — Config loader (seldonclaw.config.yaml) + sanitizeForStorage()
 *
 * Source of truth: PLAN.md §SimConfig (lines 1466-1555)
 *
 * Loads YAML config, validates required fields and ranges,
 * strips secrets for storage in run_manifest.config_snapshot.
 */

import { readFileSync } from "node:fs";
import YAML from "yaml";

// ═══════════════════════════════════════════════════════
// CONFIG TYPES — from PLAN.md §SimConfig
// ═══════════════════════════════════════════════════════

export interface SimConfig {
  simulation: SimulationConfig;
  cognition: CognitionConfig;
  providers: ProvidersConfig;
  nullclaw: NullClawConfig;
  feed: FeedConfig;
  propagation: PropagationConfig;
  fatigue: FatigueConfig;
  events: EventConfig;
  output: OutputConfig;
}

export interface SimulationConfig {
  platform: "x";
  totalHours: number;
  minutesPerRound: number;
  timezone: string;
  concurrency: number;
  seed: number;
  snapshotEvery: number;
  peakHours: number[];
  offPeakHours: number[];
}

export interface CognitionConfig {
  tierA: {
    minInfluence: number;
    archetypeOverrides: string[];
  };
  tierB: {
    samplingRate: number;
  };
  tierC: {
    repostProb: number;
    likeProb: number;
  };
  interactionLookback: number;
}

export interface ProviderConfig {
  sdk?: string;
  model: string;
  apiKeyEnv: string;
}

export interface ProvidersConfig {
  analysis: ProviderConfig;
  generation: ProviderConfig;
  simulation: ProviderConfig;
  report: ProviderConfig;
}

export interface NullClawConfig {
  gatewayUrl: string;
  binary: string;
  autoStart: boolean;
  upstreamProvider: string;
  pairing: {
    enabled: boolean;
    token: string;
  };
  agentProfile: {
    name: string;
    capabilities: string[];
  };
}

export interface FeedConfig {
  size: number;
  recencyWeight: number;
  popularityWeight: number;
  relevanceWeight: number;
  echoChamberStrength: number;
}

export interface PropagationConfig {
  viralThreshold: number;
  crossCommunityDecay: number;
  influenceMultiplier: number;
}

export interface FatigueConfig {
  decayRate: number;
  extinctionThreshold: number;
  reactivationBoost: number;
}

export interface InitialPost {
  content: string;
  topics: string[];
  actorArchetype?: string;
}

export interface ScheduledEvent {
  round: number;
  content: string;
  topics: string[];
  actorArchetype?: string;
}

export interface ThresholdTrigger {
  condition: string;
  event: string;
  actorArchetype: string;
}

export interface EventConfig {
  initialPosts: InitialPost[];
  scheduled: ScheduledEvent[];
  thresholdTriggers: ThresholdTrigger[];
}

export interface OutputConfig {
  dir: string;
  format: "markdown" | "json" | "both";
}

/** ActivationConfig — derived by engine.ts from SimConfig */
export interface ActivationConfig {
  peakHours: number[];
  offPeakHours: number[];
  peakHourMultiplier: number;
  offPeakMultiplier: number;
  eventBoostMultiplier: number;
  fatiguePenaltyWeight: number;
}

// ═══════════════════════════════════════════════════════
// DEFAULTS — safe values if omitted from config
// ═══════════════════════════════════════════════════════

const DEFAULTS: SimConfig = {
  simulation: {
    platform: "x",
    totalHours: 72,
    minutesPerRound: 60,
    timezone: "America/Bogota",
    concurrency: 1,
    seed: 42,
    snapshotEvery: 10,
    peakHours: [8, 9, 10, 12, 13, 19, 20, 21, 22],
    offPeakHours: [0, 1, 2, 3, 4, 5, 6],
  },
  cognition: {
    tierA: {
      minInfluence: 0.8,
      archetypeOverrides: ["institution", "media"],
    },
    tierB: {
      samplingRate: 0.3,
    },
    tierC: {
      repostProb: 0.4,
      likeProb: 0.6,
    },
    interactionLookback: 5,
  },
  providers: {
    analysis: {
      sdk: "anthropic",
      model: "claude-sonnet-4-20250514",
      apiKeyEnv: "ANTHROPIC_API_KEY",
    },
    generation: {
      sdk: "anthropic",
      model: "claude-sonnet-4-20250514",
      apiKeyEnv: "ANTHROPIC_API_KEY",
    },
    simulation: {
      model: "claude-haiku-4-20250414",
      apiKeyEnv: "ANTHROPIC_API_KEY",
    },
    report: {
      sdk: "anthropic",
      model: "claude-sonnet-4-20250514",
      apiKeyEnv: "ANTHROPIC_API_KEY",
    },
  },
  nullclaw: {
    gatewayUrl: "http://localhost:3000",
    binary: "nullclaw",
    autoStart: true,
    upstreamProvider: "simulation",
    pairing: {
      enabled: true,
      token: "",
    },
    agentProfile: {
      name: "seldonclaw-worker",
      capabilities: ["decide", "interview"],
    },
  },
  feed: {
    size: 20,
    recencyWeight: 0.4,
    popularityWeight: 0.3,
    relevanceWeight: 0.3,
    echoChamberStrength: 0.5,
  },
  propagation: {
    viralThreshold: 30,
    crossCommunityDecay: 0.7,
    influenceMultiplier: 1.5,
  },
  fatigue: {
    decayRate: 0.05,
    extinctionThreshold: 0.1,
    reactivationBoost: 0.6,
  },
  events: {
    initialPosts: [],
    scheduled: [],
    thresholdTriggers: [
      {
        condition: "avgSentiment(topic) < -0.6",
        event: "Institutional response statement",
        actorArchetype: "institution",
      },
      {
        condition: "postCount(topic) > 50",
        event: "National media covers the situation",
        actorArchetype: "media",
      },
    ],
  },
  output: {
    dir: "./output",
    format: "both",
  },
};

// ═══════════════════════════════════════════════════════
// LOADER
// ═══════════════════════════════════════════════════════

/**
 * Load config from YAML file, merge with defaults.
 */
export function loadConfig(filePath: string): SimConfig {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = YAML.parse(raw) as Partial<SimConfig>;
  const config = deepMerge(
    DEFAULTS as unknown as Record<string, unknown>,
    (parsed ?? {}) as Record<string, unknown>
  ) as unknown as SimConfig;
  validateConfig(config);
  return config;
}

/**
 * Parse config from a YAML string (for testing).
 */
export function parseConfig(yamlString: string): SimConfig {
  const parsed = YAML.parse(yamlString) as Partial<SimConfig>;
  const config = deepMerge(
    DEFAULTS as unknown as Record<string, unknown>,
    (parsed ?? {}) as Record<string, unknown>
  ) as unknown as SimConfig;
  validateConfig(config);
  return config;
}

/**
 * Get default config (no file needed).
 */
export function defaultConfig(): SimConfig {
  return structuredClone(DEFAULTS);
}

// ═══════════════════════════════════════════════════════
// SANITIZE — strip secrets for run_manifest.config_snapshot
// ═══════════════════════════════════════════════════════

/**
 * Strip API keys, pairing tokens, and other secrets.
 * Returns a clean JSON string safe for persistent storage.
 */
export function sanitizeForStorage(config: SimConfig): string {
  const sanitized = structuredClone(config);

  // Strip API key env names (they reference env vars, not actual keys)
  // But still redact to avoid leaking which env vars hold keys
  for (const [, provider] of Object.entries(sanitized.providers)) {
    if (provider && typeof provider === "object" && "apiKeyEnv" in provider) {
      (provider as ProviderConfig).apiKeyEnv = "[REDACTED]";
    }
  }

  // Strip pairing token
  if (sanitized.nullclaw?.pairing) {
    sanitized.nullclaw.pairing.token = "[REDACTED]";
  }

  return JSON.stringify(sanitized, null, 2);
}

// ═══════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly field: string
  ) {
    super(`Config error [${field}]: ${message}`);
    this.name = "ConfigError";
  }
}

function validateConfig(config: SimConfig): void {
  const errors: ConfigError[] = [];

  // Simulation
  if (config.simulation.seed < 0) {
    errors.push(new ConfigError("seed must be >= 0", "simulation.seed"));
  }
  if (config.simulation.totalHours <= 0) {
    errors.push(
      new ConfigError("totalHours must be > 0", "simulation.totalHours")
    );
  }
  if (config.simulation.minutesPerRound <= 0) {
    errors.push(
      new ConfigError(
        "minutesPerRound must be > 0",
        "simulation.minutesPerRound"
      )
    );
  }
  if (config.simulation.concurrency < 1) {
    errors.push(
      new ConfigError("concurrency must be >= 1", "simulation.concurrency")
    );
  }
  if (config.simulation.platform !== "x") {
    errors.push(
      new ConfigError(
        'platform must be "x" in v1',
        "simulation.platform"
      )
    );
  }

  // Cognition
  if (
    config.cognition.tierA.minInfluence < 0 ||
    config.cognition.tierA.minInfluence > 1
  ) {
    errors.push(
      new ConfigError(
        "minInfluence must be between 0 and 1",
        "cognition.tierA.minInfluence"
      )
    );
  }
  if (
    config.cognition.tierB.samplingRate < 0 ||
    config.cognition.tierB.samplingRate > 1
  ) {
    errors.push(
      new ConfigError(
        "samplingRate must be between 0 and 1",
        "cognition.tierB.samplingRate"
      )
    );
  }
  if (
    config.cognition.tierC.repostProb < 0 ||
    config.cognition.tierC.repostProb > 1
  ) {
    errors.push(
      new ConfigError(
        "repostProb must be between 0 and 1",
        "cognition.tierC.repostProb"
      )
    );
  }
  if (
    config.cognition.tierC.likeProb < 0 ||
    config.cognition.tierC.likeProb > 1
  ) {
    errors.push(
      new ConfigError(
        "likeProb must be between 0 and 1",
        "cognition.tierC.likeProb"
      )
    );
  }
  if (config.cognition.interactionLookback < 1) {
    errors.push(
      new ConfigError(
        "interactionLookback must be >= 1",
        "cognition.interactionLookback"
      )
    );
  }

  // Feed
  if (config.feed.size < 1) {
    errors.push(new ConfigError("feed size must be >= 1", "feed.size"));
  }
  const weightSum =
    config.feed.recencyWeight +
    config.feed.popularityWeight +
    config.feed.relevanceWeight;
  if (Math.abs(weightSum - 1.0) > 0.01) {
    errors.push(
      new ConfigError(
        `feed weights must sum to ~1.0 (got ${weightSum.toFixed(3)})`,
        "feed.weights"
      )
    );
  }

  // Propagation
  if (config.propagation.viralThreshold < 1) {
    errors.push(
      new ConfigError(
        "viralThreshold must be >= 1",
        "propagation.viralThreshold"
      )
    );
  }

  // Fatigue
  if (config.fatigue.decayRate <= 0 || config.fatigue.decayRate >= 1) {
    errors.push(
      new ConfigError(
        "decayRate must be between 0 (exclusive) and 1 (exclusive)",
        "fatigue.decayRate"
      )
    );
  }
  if (
    config.fatigue.extinctionThreshold < 0 ||
    config.fatigue.extinctionThreshold > 1
  ) {
    errors.push(
      new ConfigError(
        "extinctionThreshold must be between 0 and 1",
        "fatigue.extinctionThreshold"
      )
    );
  }

  if (errors.length > 0) {
    throw errors[0]; // Throw first error with field info
  }
}

// ═══════════════════════════════════════════════════════
// HELPER: derive ActivationConfig from SimConfig
// ═══════════════════════════════════════════════════════

export function deriveActivationConfig(config: SimConfig): ActivationConfig {
  return {
    peakHours: config.simulation.peakHours,
    offPeakHours: config.simulation.offPeakHours,
    peakHourMultiplier: 1.5,
    offPeakMultiplier: 0.3,
    eventBoostMultiplier: 2.0,
    fatiguePenaltyWeight: -0.3,
  };
}

// ═══════════════════════════════════════════════════════
// HELPER: compute total rounds from config
// ═══════════════════════════════════════════════════════

export function totalRounds(config: SimConfig): number {
  return Math.ceil(
    (config.simulation.totalHours * 60) / config.simulation.minutesPerRound
  );
}

// ═══════════════════════════════════════════════════════
// INTERNAL: deep merge with undefined handling
// ═══════════════════════════════════════════════════════

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = target[key];
    if (
      sourceVal &&
      typeof sourceVal === "object" &&
      !Array.isArray(sourceVal) &&
      targetVal &&
      typeof targetVal === "object" &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>
      );
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal;
    }
  }
  return result;
}
