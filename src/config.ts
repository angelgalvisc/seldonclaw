/**
 * config.ts — Config loader (publicmachina.config.yaml) + sanitizeForStorage()
 *
 * Source of truth: PLAN.md §SimConfig (lines 1466-1555)
 *
 * Loads YAML config, validates required fields and ranges,
 * strips secrets for storage in run_manifest.config_snapshot.
 */

import { readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import type { FeedAlgorithm, PlatformAction, PlatformPolicyConfig } from "./platform.js";
import { DEFAULT_PLATFORM_POLICY, PLATFORM_ACTIONS } from "./platform.js";
import {
  PROVIDER_ROLES,
  normalizeProvidersConfig,
  resolveProviderConfig,
  type ProviderConfig,
  type ProviderRole,
  type ProvidersConfig,
} from "./provider-selection.js";

// ═══════════════════════════════════════════════════════
// CONFIG TYPES — from PLAN.md §SimConfig
// ═══════════════════════════════════════════════════════

export interface SimConfig {
  simulation: SimulationConfig;
  cognition: CognitionConfig;
  providers: ProvidersConfig;
  assistant: AssistantConfig;
  platform: PlatformPolicyConfig;
  search: SearchConfig;
  feed: FeedConfig;
  propagation: PropagationConfig;
  fatigue: FatigueConfig;
  events: EventConfig;
  output: OutputConfig;
}

export interface SimulationConfig {
  platform: string;
  totalHours: number;
  minutesPerRound: number;
  timezone: string;
  concurrency: number;
  timeAccelerationMode: "off" | "fast-forward";
  maxFastForwardRounds: number;
  seed: number;
  snapshotEvery: number;
  pipelineConcurrency: number;
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

export interface FeedConfig {
  size: number;
  algorithm: FeedAlgorithm;
  recencyWeight: number;
  popularityWeight: number;
  relevanceWeight: number;
  echoChamberStrength: number;
  traceWeight: number;
  outOfNetworkRatio: number;
  diversityWeight: number;
  embeddingEnabled: boolean;
  embeddingWeight: number;
  embeddingModel: string;
  embeddingDimensions: number;
}

export interface SearchConfig {
  enabled: boolean;
  endpoint: string;
  cutoffDate: string;
  strictCutoff: boolean;
  enabledTiers: Array<"A" | "B">;
  maxActorsPerRound: number;
  maxActorsByTier: {
    A: number;
    B: number;
  };
  allowArchetypes: string[];
  denyArchetypes: string[];
  allowProfessions: string[];
  denyProfessions: string[];
  allowActors: string[];
  denyActors: string[];
  maxResultsPerQuery: number;
  maxQueriesPerActor: number;
  categories: string;
  defaultLanguage: string;
  timeoutMs: number;
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

export interface AssistantConfig {
  enabled: boolean;
  workspaceDir: string;
  permissions: AssistantPermissionsConfig;
  memory: AssistantMemoryConfig;
  limits: AssistantLimitsConfig;
}

export interface AssistantPermissionsConfig {
  readWorkspace: boolean;
  writeWorkspace: boolean;
  rememberConversations: boolean;
  rememberSimulationHistory: boolean;
}

export interface AssistantMemoryConfig {
  recentSessionMessages: number;
  recentDailyNotes: number;
  relevantSimulationLimit: number;
}

export interface AssistantLimitsConfig {
  sessionCostBudgetUsd: number;
  maxConcurrentRuns: number;
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
    timezone: "UTC",
    concurrency: 1,
    timeAccelerationMode: "off",
    maxFastForwardRounds: 24,
    seed: 42,
    snapshotEvery: 10,
    pipelineConcurrency: 3,
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
    default: {
      provider: "anthropic",
      sdk: "anthropic",
      model: "claude-sonnet-4-6",
      apiKeyEnv: "ANTHROPIC_API_KEY",
    },
    overrides: {},
  },
  assistant: {
    enabled: true,
    workspaceDir: "./publicmachina-workspace",
    permissions: {
      readWorkspace: true,
      writeWorkspace: true,
      rememberConversations: true,
      rememberSimulationHistory: true,
    },
    memory: {
      recentSessionMessages: 12,
      recentDailyNotes: 2,
      relevantSimulationLimit: 3,
    },
    limits: {
      sessionCostBudgetUsd: 10,
      maxConcurrentRuns: 1,
    },
  },
  platform: structuredClone(DEFAULT_PLATFORM_POLICY),
  search: {
    enabled: false,
    endpoint: "http://localhost:8888",
    cutoffDate: "9999-12-31",
    strictCutoff: true,
    enabledTiers: ["A", "B"],
    maxActorsPerRound: 4,
    maxActorsByTier: {
      A: 2,
      B: 2,
    },
    allowArchetypes: [],
    denyArchetypes: [],
    allowProfessions: [],
    denyProfessions: [],
    allowActors: [],
    denyActors: [],
    maxResultsPerQuery: 5,
    maxQueriesPerActor: 2,
    categories: "news",
    defaultLanguage: "auto",
    timeoutMs: 3000,
  },
  feed: {
    size: 20,
    algorithm: "hybrid",
    recencyWeight: 0.4,
    popularityWeight: 0.3,
    relevanceWeight: 0.3,
    echoChamberStrength: 0.5,
    traceWeight: 0.25,
    outOfNetworkRatio: 0.35,
    diversityWeight: 0.2,
    embeddingEnabled: false,
    embeddingWeight: 0.25,
    embeddingModel: "hash-embedding-v1",
    embeddingDimensions: 32,
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
  const config = normalizeConfig(deepMerge(
    DEFAULTS as unknown as Record<string, unknown>,
    (parsed ?? {}) as Record<string, unknown>
  ) as unknown as SimConfig, parsed);
  validateConfig(config);
  return config;
}

/**
 * Parse config from a YAML string (for testing).
 */
export function parseConfig(yamlString: string): SimConfig {
  const parsed = YAML.parse(yamlString) as Partial<SimConfig>;
  const config = normalizeConfig(deepMerge(
    DEFAULTS as unknown as Record<string, unknown>,
    (parsed ?? {}) as Record<string, unknown>
  ) as unknown as SimConfig, parsed);
  validateConfig(config);
  return config;
}

/**
 * Get default config (no file needed).
 */
export function defaultConfig(): SimConfig {
  return structuredClone(DEFAULTS);
}

export function saveConfig(filePath: string, config: SimConfig): void {
  validateConfig(config);
  writeFileSync(
    filePath,
    YAML.stringify(config, {
      lineWidth: 0,
      defaultKeyType: "PLAIN",
      defaultStringType: "QUOTE_DOUBLE",
    }),
    "utf-8"
  );
}

function normalizeConfig(config: SimConfig, parsed: Partial<SimConfig>): SimConfig {
  config.providers = normalizeProvidersConfig(parsed.providers ?? config.providers, DEFAULTS.providers);

  if (!parsed.platform?.name && parsed.simulation?.platform) {
    config.platform.name = parsed.simulation.platform;
  }

  if (!parsed.platform?.recsys && parsed.feed?.algorithm) {
    config.platform.recsys = parsed.feed.algorithm;
  }

  config.simulation.platform = config.platform.name;
  config.feed.algorithm = config.platform.recsys;
  return config;
}

// ═══════════════════════════════════════════════════════
// SANITIZE — strip secrets for run_manifest.config_snapshot
// ═══════════════════════════════════════════════════════

/**
 * Strip API key env names and other secret-bearing references.
 * Returns a clean JSON string safe for persistent storage.
 */
export function sanitizeForStorage(config: SimConfig): string {
  const sanitized = structuredClone(config);

  sanitized.providers.default.apiKeyEnv = "[REDACTED]";
  for (const role of PROVIDER_ROLES) {
    if (sanitized.providers.overrides[role]?.apiKeyEnv) {
      sanitized.providers.overrides[role]!.apiKeyEnv = "[REDACTED]";
    }
  }
  sanitized.assistant.workspaceDir = "[REDACTED]";

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

  for (const role of PROVIDER_ROLES) {
    const provider = resolveProviderConfig(config.providers, role);
    if (!provider.provider) {
      errors.push(
        new ConfigError(
          'provider must be "anthropic", "openai", or "moonshot"',
          `providers.${role}.provider`
        )
      );
    }
    if (!provider.model.trim()) {
      errors.push(new ConfigError("model must not be empty", `providers.${role}.model`));
    }
    if (!provider.apiKeyEnv.trim()) {
      errors.push(new ConfigError("apiKeyEnv must not be empty", `providers.${role}.apiKeyEnv`));
    }
    if (provider.baseUrl && !/^https?:\/\//.test(provider.baseUrl)) {
      errors.push(
        new ConfigError("baseUrl must start with http:// or https://", `providers.${role}.baseUrl`)
      );
    }
  }

  if (!config.assistant.workspaceDir.trim()) {
    errors.push(new ConfigError("workspaceDir must not be empty", "assistant.workspaceDir"));
  }
  if (config.assistant.memory.recentSessionMessages < 1) {
    errors.push(
      new ConfigError(
        "recentSessionMessages must be >= 1",
        "assistant.memory.recentSessionMessages"
      )
    );
  }
  if (config.assistant.memory.recentDailyNotes < 0) {
    errors.push(
      new ConfigError(
        "recentDailyNotes must be >= 0",
        "assistant.memory.recentDailyNotes"
      )
    );
  }
  if (config.assistant.memory.relevantSimulationLimit < 1) {
    errors.push(
      new ConfigError(
        "relevantSimulationLimit must be >= 1",
        "assistant.memory.relevantSimulationLimit"
      )
    );
  }
  if (config.assistant.limits.sessionCostBudgetUsd <= 0) {
    errors.push(
      new ConfigError(
        "sessionCostBudgetUsd must be > 0",
        "assistant.limits.sessionCostBudgetUsd"
      )
    );
  }
  if (config.assistant.limits.maxConcurrentRuns < 1) {
    errors.push(
      new ConfigError(
        "maxConcurrentRuns must be >= 1",
        "assistant.limits.maxConcurrentRuns"
      )
    );
  }

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
  if (config.simulation.pipelineConcurrency < 1) {
    errors.push(
      new ConfigError("pipelineConcurrency must be >= 1", "simulation.pipelineConcurrency")
    );
  }
  if (
    config.simulation.timeAccelerationMode !== "off" &&
    config.simulation.timeAccelerationMode !== "fast-forward"
  ) {
    errors.push(
      new ConfigError(
        'timeAccelerationMode must be "off" or "fast-forward"',
        "simulation.timeAccelerationMode"
      )
    );
  }
  if (config.simulation.maxFastForwardRounds < 1) {
    errors.push(
      new ConfigError(
        "maxFastForwardRounds must be >= 1",
        "simulation.maxFastForwardRounds"
      )
    );
  }
  if (!config.simulation.platform.trim()) {
    errors.push(
      new ConfigError(
        "platform must not be empty",
        "simulation.platform"
      )
    );
  }
  if (config.platform.name !== config.simulation.platform) {
    errors.push(
      new ConfigError(
        "platform.name must match simulation.platform",
        "platform.name"
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
  if (
    ![
      "chronological",
      "heuristic",
      "trace-aware",
      "embedding",
      "hybrid",
    ].includes(config.feed.algorithm)
  ) {
    errors.push(
      new ConfigError(
        "feed.algorithm must be chronological, heuristic, trace-aware, embedding, or hybrid",
        "feed.algorithm"
      )
    );
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
  if (
    config.feed.embeddingWeight < 0 ||
    config.feed.embeddingWeight > 1
  ) {
    errors.push(
      new ConfigError(
        "embeddingWeight must be between 0 and 1",
        "feed.embeddingWeight"
      )
    );
  }
  if (config.feed.traceWeight < 0 || config.feed.traceWeight > 1) {
    errors.push(
      new ConfigError(
        "traceWeight must be between 0 and 1",
        "feed.traceWeight"
      )
    );
  }
  if (config.feed.outOfNetworkRatio < 0 || config.feed.outOfNetworkRatio > 1) {
    errors.push(
      new ConfigError(
        "outOfNetworkRatio must be between 0 and 1",
        "feed.outOfNetworkRatio"
      )
    );
  }
  if (config.feed.diversityWeight < 0 || config.feed.diversityWeight > 1) {
    errors.push(
      new ConfigError(
        "diversityWeight must be between 0 and 1",
        "feed.diversityWeight"
      )
    );
  }

  for (const action of config.platform.actions) {
    if (!(PLATFORM_ACTIONS as readonly string[]).includes(action)) {
      errors.push(
        new ConfigError(
          `unknown platform action: ${action}`,
          "platform.actions"
        )
      );
    }
  }
  const allKnownActions = new Set<string>(PLATFORM_ACTIONS);
  for (const tier of ["A", "B", "C"] as const) {
    const tierActions = config.platform.tierAllowedActions[tier] ?? [];
    for (const action of tierActions) {
      if (!allKnownActions.has(action)) {
        errors.push(
          new ConfigError(
            `unknown action ${action} in tierAllowedActions.${tier}`,
            `platform.tierAllowedActions.${tier}`
          )
        );
      }
      if (!config.platform.actions.includes(action as PlatformAction)) {
        errors.push(
          new ConfigError(
            `tierAllowedActions.${tier} contains action not enabled in platform.actions: ${action}`,
            `platform.tierAllowedActions.${tier}`
          )
        );
      }
    }
  }
  if (config.platform.moderation.reportThreshold < 1) {
    errors.push(
      new ConfigError(
        "reportThreshold must be >= 1",
        "platform.moderation.reportThreshold"
      )
    );
  }
  if (config.feed.embeddingDimensions < 4) {
    errors.push(
      new ConfigError(
        "embeddingDimensions must be >= 4",
        "feed.embeddingDimensions"
      )
    );
  }

  // Search
  if (config.search.maxResultsPerQuery < 1) {
    errors.push(
      new ConfigError(
        "maxResultsPerQuery must be >= 1",
        "search.maxResultsPerQuery"
      )
    );
  }
  if (config.search.maxQueriesPerActor < 0) {
    errors.push(
      new ConfigError(
        "maxQueriesPerActor must be >= 0",
        "search.maxQueriesPerActor"
      )
    );
  }
  if (config.search.timeoutMs < 100) {
    errors.push(
      new ConfigError(
        "timeoutMs must be >= 100",
        "search.timeoutMs"
      )
    );
  }
  if (config.search.enabled && config.search.enabledTiers.length === 0) {
    errors.push(
      new ConfigError(
        "enabledTiers must contain at least one tier",
        "search.enabledTiers"
      )
    );
  }
  if (
    config.search.enabledTiers.some(
      (tier) => tier !== "A" && tier !== "B"
    )
  ) {
    errors.push(
      new ConfigError(
        'enabledTiers may only contain "A" and "B"',
        "search.enabledTiers"
      )
    );
  }
  if (config.search.maxActorsPerRound < 0) {
    errors.push(
      new ConfigError(
        "maxActorsPerRound must be >= 0",
        "search.maxActorsPerRound"
      )
    );
  }
  if (config.search.maxActorsByTier.A < 0) {
    errors.push(
      new ConfigError(
        "maxActorsByTier.A must be >= 0",
        "search.maxActorsByTier.A"
      )
    );
  }
  if (config.search.maxActorsByTier.B < 0) {
    errors.push(
      new ConfigError(
        "maxActorsByTier.B must be >= 0",
        "search.maxActorsByTier.B"
      )
    );
  }
  if (
    config.search.enabled &&
    !/^https?:\/\//.test(config.search.endpoint)
  ) {
    errors.push(
      new ConfigError(
        "endpoint must start with http:// or https:// when search is enabled",
        "search.endpoint"
      )
    );
  }
  if (
    config.search.cutoffDate &&
    Number.isNaN(Date.parse(config.search.cutoffDate))
  ) {
    errors.push(
      new ConfigError(
        "cutoffDate must be a valid ISO date or datetime",
        "search.cutoffDate"
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
