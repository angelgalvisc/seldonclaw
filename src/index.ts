#!/usr/bin/env node
/**
 * index.ts — CLI entry point for SeldonClaw
 *
 * Source of truth: PLAN.md §CLI, CLAUDE.md Phase 5.2
 *
 * Commander-based CLI with subcommands:
 *   design — natural-language simulation planning -> spec + config
 *   run/ingest/analyze/generate/simulate — pipeline + simulation entry points
 *   stats/report/interview/export/import/shell — analysis and operator tools
 *   resume/replay — planned follow-ups (still stubbed)
 */

import { Command } from "commander";
import { pathToFileURL } from "node:url";
import { SQLiteGraphStore, uuid } from "./db.js";
import { loadConfig, defaultConfig, sanitizeForStorage } from "./config.js";
import type { SimConfig } from "./config.js";
import { DirectLLMBackend, MockCognitionBackend, getPromptVersion } from "./cognition.js";
import { runSimulation } from "./engine.js";
import { getTierStats } from "./telemetry.js";
import { LLMClient, MockLLMClient } from "./llm.js";
import { interviewActor, resolveActorByName, formatActorContext } from "./interview.js";
import { exportAgent, importAgent } from "./ckp.js";
import { generateReport } from "./report.js";
import { startShell } from "./shell.js";
import { ingestDirectory } from "./ingest.js";
import { extractOntology } from "./ontology.js";
import { buildKnowledgeGraph } from "./graph.js";
import { generateProfiles } from "./profiles.js";
import { designSimulationFromBrief } from "./design.js";
import { checkSearchHealth, createSearchProvider } from "./search.js";
import type { RunManifest } from "./db.js";
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface PromptSession {
  ask: (question: string, defaultValue?: string) => Promise<string>;
  close: () => void;
}

const defaultIO: CliIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function parseIntOption(value: string, field: string): number {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ${field}: ${value}`);
  }
  return parsed;
}

function getConfig(configPath?: string): SimConfig {
  return configPath ? loadConfig(configPath) : defaultConfig();
}

function createCliLlm(
  config: SimConfig,
  options: { mock?: boolean; feature?: "report" | "shell" | "design" } = {}
): LLMClient {
  if (options.mock) {
    const llm = new MockLLMClient();
    if (options.feature === "report") {
      llm.setResponse("Rounds completed:", "Mock report narrative");
    }
    if (options.feature === "design") {
      llm.setResponse(
        "Interpret the following simulation brief",
        JSON.stringify({
          title: "Global Product Recall Response",
          objective:
            "Simulate how narratives and institutional responses evolve after a global consumer electronics recall.",
          hypothesis:
            "Journalists and regulators accelerate negative sentiment faster than the company can stabilize the narrative.",
          docsPath: null,
          rounds: 10,
          focusActors: ["customers", "journalists", "regulators", "company spokespeople", "investors"],
          search: {
            enabled: true,
            enabledTiers: ["A", "B"],
            maxActorsPerRound: 4,
            maxActorsByTier: { A: 2, B: 2 },
            allowArchetypes: ["institution"],
            denyArchetypes: [],
            allowProfessions: ["journalist", "analyst"],
            denyProfessions: [],
            allowActors: [],
            denyActors: [],
            cutoffDate: "2026-03-01",
            categories: "news",
            defaultLanguage: "auto",
            maxResultsPerQuery: 5,
            maxQueriesPerActor: 2,
            strictCutoff: true,
            timeoutMs: 3000,
          },
          feed: {
            embeddingEnabled: true,
            embeddingWeight: 0.35,
          },
          assumptions: [
            "Assumed the default X-style platform profile unless overridden by an explicit platform policy.",
          ],
          warnings: [],
        })
      );
    }
    return llm;
  }
  return new LLMClient(config.providers);
}

function createPipelineMockLlm(): MockLLMClient {
  const llm = new MockLLMClient();
  llm.setResponse(
    "Analyze the following document chunks and extract the ontology schema.",
    JSON.stringify({
      entity_types: [
        { name: "person", description: "Individual actor", attributes: ["name", "role"] },
        { name: "organization", description: "Institution or organization", attributes: ["name"] },
      ],
      edge_types: [
        {
          name: "opposes",
          description: "Publicly opposes",
          source_type: "person",
          target_type: "organization",
        },
      ],
    })
  );
  llm.setResponse(
    "Extract all factual claims from the following text chunks.",
    JSON.stringify({
      claims: [
        {
          subject: "Elena Ruiz",
          predicate: "opposes",
          object: "Universidad Central",
          confidence: 0.9,
          valid_from: null,
          valid_to: null,
          topics: ["education", "protest"],
        },
      ],
    })
  );
  llm.setResponse(
    "Generate a social media profile for the following entity",
    JSON.stringify({
      personality: "A civically engaged account that comments on public issues with concise, evidence-oriented posts.",
      bio: "Public affairs observer",
      age: 32,
      gender: null,
      profession: "journalist",
      region: "Bogota",
      language: "es",
      stance: "opposing",
      sentiment_bias: -0.3,
      activity_level: 0.7,
      influence_weight: 0.6,
      handle: "@sim_actor",
      topics: [{ topic: "education", weight: 0.9 }],
      beliefs: [{ topic: "education", sentiment: -0.4 }],
    })
  );
  return llm;
}

function createPipelineLlm(config: SimConfig, mock?: boolean): LLMClient {
  return mock ? createPipelineMockLlm() : new LLMClient(config.providers);
}

function ensureRunManifest(
  store: SQLiteGraphStore,
  runId: string,
  config: SimConfig,
  hypothesis?: string
): void {
  const existing = store.getRun(runId);
  const graphRevisionId = store.computeGraphRevisionId();
  const payload: RunManifest = {
    id: runId,
    started_at: existing?.started_at ?? new Date().toISOString(),
    seed: config.simulation.seed,
    config_snapshot: sanitizeForStorage(config),
    graph_revision_id: graphRevisionId,
    hypothesis: hypothesis ?? existing?.hypothesis,
    total_rounds: existing?.total_rounds,
    status: existing?.status ?? "paused",
    finished_at: existing?.finished_at,
    resumed_from: existing?.resumed_from,
    version: existing?.version,
    docs_hash: existing?.docs_hash,
  };

  if (existing) {
    store.updateRun(runId, payload);
  } else {
    store.createRun(payload);
  }
}

function createPromptSession(): PromptSession {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return {
    ask: (question, defaultValue) =>
      new Promise<string>((resolve, reject) => {
        const suffix = defaultValue ? ` [${defaultValue}]` : "";
        rl.question(`${question}${suffix}: `, (answer) => {
          const trimmed = answer.trim();
          resolve(trimmed || defaultValue || "");
        });
        rl.once("close", () => reject(new Error("Prompt closed")));
      }),
    close: () => rl.close(),
  };
}

interface InitAnswers {
  simulationModel: string;
  reportModel: string;
  apiKeyEnv: string;
  outputDir: string;
  timezone: string;
  searchEnabled: boolean;
  searchEndpoint: string;
  searchCutoffDate: string;
}

function renderInitConfig(answers: InitAnswers): string {
  return [
    "# SeldonClaw Configuration",
    "# Generated by: seldonclaw init",
    "",
    "simulation:",
    '  platform: "x"',
    "  totalHours: 24",
    "  minutesPerRound: 60",
    `  timezone: "${answers.timezone}"`,
    "  concurrency: 1",
    '  timeAccelerationMode: "off"',
    "  maxFastForwardRounds: 24",
    "  seed: 42",
    "  snapshotEvery: 10",
    "",
    "platform:",
    '  name: "x"',
    "  features:",
    "    upvoteDownvote: false",
    "    threads: false",
    "    characterLimit: 280",
    "    anonymousPosting: false",
    "    communitiesUserCreated: false",
    "  actions: [post, comment, repost, quote, like, unlike, follow, unfollow, mute, block, report, delete, search, idle]",
    '  recsys: "hybrid"',
    "  tierAllowedActions:",
    "    A: [post, comment, repost, quote, like, unlike, follow, unfollow, mute, block, report, delete, search, idle]",
    "    B: [post, comment, repost, quote, like, unlike, follow, unfollow, mute, report, delete, search, idle]",
    "    C: [post, comment, repost, like, follow, unfollow, idle]",
    "  moderation:",
    "    enabled: true",
    "    reportThreshold: 3",
    "    shadowBanOnThreshold: true",
    "",
    "feed:",
    '  algorithm: "hybrid"',
    "  size: 20",
    "  recencyWeight: 0.4",
    "  popularityWeight: 0.3",
    "  relevanceWeight: 0.3",
    "  echoChamberStrength: 0.5",
    "  traceWeight: 0.25",
    "  outOfNetworkRatio: 0.35",
    "  diversityWeight: 0.2",
    "  embeddingEnabled: false",
    "  embeddingWeight: 0.25",
    '  embeddingModel: "hash-embedding-v1"',
    "  embeddingDimensions: 32",
    "",
    "providers:",
    "  analysis:",
    '    sdk: "anthropic"',
    `    model: "${answers.simulationModel}"`,
    `    apiKeyEnv: "${answers.apiKeyEnv}"`,
    "  generation:",
    '    sdk: "anthropic"',
    `    model: "${answers.simulationModel}"`,
    `    apiKeyEnv: "${answers.apiKeyEnv}"`,
    "  simulation:",
    `    model: "${answers.simulationModel}"`,
    `    apiKeyEnv: "${answers.apiKeyEnv}"`,
    "  report:",
    '    sdk: "anthropic"',
    `    model: "${answers.reportModel}"`,
    `    apiKeyEnv: "${answers.apiKeyEnv}"`,
    "",
    "search:",
    `  enabled: ${answers.searchEnabled ? "true" : "false"}`,
    `  endpoint: "${answers.searchEndpoint}"`,
    `  cutoffDate: "${answers.searchCutoffDate}"`,
    "  strictCutoff: true",
    '  enabledTiers: ["A", "B"]',
    "  maxActorsPerRound: 4",
    "  maxActorsByTier:",
    "    A: 2",
    "    B: 2",
    "  allowArchetypes: []",
    "  denyArchetypes: []",
    "  allowProfessions: []",
    "  denyProfessions: []",
    "  allowActors: []",
    "  denyActors: []",
    "  maxResultsPerQuery: 5",
    "  maxQueriesPerActor: 2",
    '  categories: "news"',
    '  defaultLanguage: "auto"',
    "  timeoutMs: 3000",
    "",
    "output:",
    `  dir: "${answers.outputDir}"`,
    '  format: "markdown"',
    "",
  ].join("\n");
}

export async function runInitCommand(
  opts: { output: string; yes?: boolean },
  io: CliIO,
  promptSession?: PromptSession
): Promise<void> {
  if (existsSync(opts.output)) {
    io.stderr(`Config already exists: ${opts.output}\n`);
    return;
  }

  const nodeVersion = process.versions.node;
  const majorVersion = parseInt(nodeVersion.split(".")[0], 10);
  if (majorVersion < 18) {
    io.stderr(`Warning: Node ${nodeVersion} detected. Node >= 18 is recommended.\n`);
  }

  const defaults = {
    simulationModel: "claude-haiku-4-20250414",
    reportModel: "claude-sonnet-4-20250514",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    outputDir: "./output",
    timezone: defaultConfig().simulation.timezone,
    searchEnabled: false,
    searchEndpoint: defaultConfig().search.endpoint,
    searchCutoffDate: defaultConfig().search.cutoffDate,
  };

  let answers: InitAnswers = defaults;
  let prompt = promptSession;

  if (!opts.yes && (process.stdin.isTTY || promptSession)) {
    prompt ??= createPromptSession();
    try {
      io.stdout("SeldonClaw setup\n");
      const enableSearchAnswer = await prompt.ask(
        "Enable SearXNG web search (yes/no)",
        defaults.searchEnabled ? "yes" : "no"
      );
      const searchEnabled = parseBooleanAnswer(enableSearchAnswer);
      answers = {
        simulationModel: await prompt.ask("Simulation model", defaults.simulationModel),
        reportModel: await prompt.ask("Report model", defaults.reportModel),
        apiKeyEnv: await prompt.ask("API key env var", defaults.apiKeyEnv),
        outputDir: await prompt.ask("Output directory", defaults.outputDir),
        timezone: await prompt.ask("Timezone", defaults.timezone),
        searchEnabled,
        searchEndpoint: searchEnabled
          ? await prompt.ask("SearXNG endpoint", defaults.searchEndpoint)
          : defaults.searchEndpoint,
        searchCutoffDate: searchEnabled
          ? await prompt.ask("Search cutoff date (ISO)", defaults.searchCutoffDate)
          : defaults.searchCutoffDate,
      };
    } finally {
      prompt.close();
    }
  }

  writeFileSync(opts.output, renderInitConfig(answers), "utf-8");
  io.stdout(`Created ${opts.output}\n`);

  const envVarExists = Boolean(process.env[answers.apiKeyEnv]);
  io.stdout(
    envVarExists
      ? `  [PASS] ${answers.apiKeyEnv} is set\n`
      : `  [WARN] ${answers.apiKeyEnv} is not set yet\n`
  );
  if (answers.searchEnabled) {
    io.stdout(`  [INFO] Web search enabled at ${answers.searchEndpoint}\n`);
  }

  try {
    const testStore = new SQLiteGraphStore(":memory:");
    testStore.close();
    io.stdout("  [PASS] SQLite open/create check\n");
  } catch (err) {
    io.stderr(`  [FAIL] SQLite check: ${formatErrorMessage(err)}\n`);
  }

  io.stdout('Next: run "seldonclaw doctor" to validate the full setup.\n');
}

function parseBooleanAnswer(value: string): boolean {
  return /^(y|yes|true|1)$/i.test(value.trim());
}

async function runDesignCommand(
  opts: {
    brief?: string;
    docs?: string;
    config?: string;
    outConfig: string;
    outSpec: string;
    yes?: boolean;
    mock?: boolean;
  },
  io: CliIO,
  promptSession?: PromptSession
): Promise<void> {
  const config = getConfig(opts.config);
  let prompt = promptSession;
  const interactive = !opts.yes && (Boolean(promptSession) || process.stdin.isTTY);
  let createdPrompt = false;

  if (!prompt && interactive) {
    prompt = createPromptSession();
    createdPrompt = true;
  }

  try {
    let brief = opts.brief?.trim() ?? "";
    if (!brief) {
      if (!prompt) {
        throw new Error('Natural-language brief required. Pass --brief or run "seldonclaw design" interactively.');
      }
      brief = await prompt.ask("Describe the simulation you want to design");
    }

    const llm = createCliLlm(config, { mock: opts.mock, feature: "design" });
    const result = await designSimulationFromBrief(llm, brief, {
      docsPath: opts.docs,
      baseConfig: config,
    });

    io.stdout(result.preview);

    const outputsExist = existsSync(opts.outConfig) || existsSync(opts.outSpec);
    if (outputsExist && !opts.yes) {
      if (!prompt) {
        throw new Error(
          `Output already exists. Remove ${opts.outConfig} / ${opts.outSpec} or rerun with --yes to overwrite.`
        );
      }
      const overwrite = await prompt.ask(
        "Output files already exist. Overwrite them? (yes/no)",
        "no"
      );
      if (!parseBooleanAnswer(overwrite)) {
        io.stdout("Aborted before writing output files.\n");
        return;
      }
    }

    if (!opts.yes) {
      if (!prompt) {
        throw new Error("Design confirmation requires interactive mode or --yes.");
      }
      const confirm = await prompt.ask("Write the generated spec and config? (yes/no)", "yes");
      if (!parseBooleanAnswer(confirm)) {
        io.stdout("Aborted before writing output files.\n");
        return;
      }
    }

    writeFileSync(opts.outSpec, `${JSON.stringify(result.spec, null, 2)}\n`, "utf-8");
    writeFileSync(opts.outConfig, result.yaml, "utf-8");

    io.stdout(`Wrote ${opts.outSpec}\n`);
    io.stdout(`Wrote ${opts.outConfig}\n`);

    const nextParts = [
      "node dist/index.js run",
      `--config ${JSON.stringify(opts.outConfig)}`,
    ];
    if (result.spec.docsPath) {
      nextParts.push(`--docs ${JSON.stringify(result.spec.docsPath)}`);
    }
    if (result.spec.hypothesis) {
      nextParts.push(`--hypothesis ${JSON.stringify(result.spec.hypothesis)}`);
    }
    io.stdout(`Next: ${nextParts.join(" ")}\n`);
  } finally {
    if (prompt && createdPrompt) {
      prompt.close();
    }
  }
}

async function runSimulateCommand(
  opts: {
    db: string;
    rounds?: string;
    seed?: string;
    config?: string;
    run?: string;
    mock?: boolean;
  },
  io: CliIO
): Promise<void> {
  let config: SimConfig = getConfig(opts.config);

  if (opts.rounds) {
    const rounds = parseIntOption(opts.rounds, "rounds");
    config.simulation.totalHours = (rounds * config.simulation.minutesPerRound) / 60;
  }

  if (opts.seed !== undefined) {
    config.simulation.seed = parseIntOption(opts.seed, "seed");
  }

  const store = new SQLiteGraphStore(opts.db);
  const runId = opts.run ?? uuid();
  const backend = opts.mock
    ? new MockCognitionBackend()
    : new DirectLLMBackend(
        new LLMClient(config.providers),
        store,
        {
          runId,
          promptVersion: getPromptVersion(),
        }
      );

  try {
    const result = await runSimulation({
      store,
      config,
      backend,
      runId,
    });

    io.stdout(`Simulation ${result.status}\n`);
    io.stdout(`  Run ID: ${result.runId}\n`);
    io.stdout(`  Rounds: ${result.totalRounds}\n`);
    io.stdout(`  Wall time: ${(result.wallTimeMs / 1000).toFixed(1)}s\n`);
  } finally {
    store.close();
  }
}

function runStatsCommand(
  opts: {
    db: string;
    tiers?: boolean;
    run?: string;
  },
  io: CliIO
): void {
  const store = new SQLiteGraphStore(opts.db);

  try {
    const runId = opts.run ?? store.getLatestRunId();
    if (!runId) {
      throw new Error("No runs found in database.");
    }

    const run = store.getRun(runId);
    if (!run) {
      throw new Error(`Run ${runId} not found.`);
    }

    io.stdout(`Run: ${runId}\n`);
    io.stdout(`  Status: ${run.status}\n`);
    io.stdout(`  Seed: ${run.seed}\n`);
    io.stdout(`  Total rounds: ${run.total_rounds ?? "unknown"}\n`);
    io.stdout(`  Started: ${run.started_at}\n`);
    if (run.finished_at) io.stdout(`  Finished: ${run.finished_at}\n`);

    const roundSummary = store.getRunRoundSummary(runId);
    io.stdout(`  Rounds completed: ${roundSummary.roundsCompleted}\n`);
    io.stdout(`  Total posts: ${roundSummary.totalPosts}\n`);
    io.stdout(`  Total actions: ${roundSummary.totalActions}\n`);
    io.stdout(`  Avg active actors/round: ${roundSummary.avgActiveActors.toFixed(1)}\n`);

    if (opts.tiers) {
      const stats = getTierStats(store, runId);
      const tierCalls = store.getRunTierCallTotals(runId);
      io.stdout(`  Tier breakdown:\n`);
      io.stdout(`    A (always LLM): ${stats.tierA} actors\n`);
      io.stdout(`    B (salient LLM): ${stats.tierB} actors\n`);
      io.stdout(`    C (rules only): ${stats.tierC} actors\n`);
      io.stdout(`    Tier A calls: ${tierCalls.tierACalls}\n`);
      io.stdout(`    Tier B calls: ${tierCalls.tierBCalls}\n`);
      io.stdout(`    Tier C actions: ${tierCalls.tierCActions}\n`);
    }
  } finally {
    store.close();
  }
}

async function runIngestCommand(
  opts: { db: string; docs: string },
  io: CliIO
): Promise<void> {
  const store = new SQLiteGraphStore(opts.db);
  try {
    const result = await ingestDirectory(store, opts.docs);
    io.stdout(`Ingested documents from ${opts.docs}\n`);
    io.stdout(`  New documents: ${result.newDocuments}\n`);
    io.stdout(`  Total chunks: ${result.totalChunks}\n`);
    io.stdout(`  Deduplicated: ${result.skippedDocuments}\n`);
    if (result.errors.length > 0) {
      io.stdout(`  Errors: ${result.errors.length}\n`);
    }
  } finally {
    store.close();
  }
}

async function runAnalyzeCommand(
  opts: { db: string; config?: string; mock?: boolean },
  io: CliIO
): Promise<void> {
  const config = getConfig(opts.config);
  const llm = createPipelineLlm(config, opts.mock);
  const store = new SQLiteGraphStore(opts.db);
  try {
    const ontology = await extractOntology(store, llm);
    const graph = await buildKnowledgeGraph(store, llm);
    io.stdout("Analysis complete\n");
    io.stdout(`  Entity types: ${ontology.entityTypes.length}\n`);
    io.stdout(`  Edge types: ${ontology.edgeTypes.length}\n`);
    io.stdout(`  Claims: ${ontology.claimsExtracted}\n`);
    io.stdout(`  Entities: ${graph.entitiesCreated}\n`);
    io.stdout(`  Edges: ${graph.edgesCreated}\n`);
    io.stdout(`  Graph revision: ${graph.graphRevisionId}\n`);
  } finally {
    store.close();
  }
}

async function runGenerateCommand(
  opts: {
    db: string;
    run?: string;
    config?: string;
    hypothesis?: string;
    mock?: boolean;
    maxActors?: string;
  },
  io: CliIO
): Promise<void> {
  const config = getConfig(opts.config);
  const llm = createPipelineLlm(config, opts.mock);
  const store = new SQLiteGraphStore(opts.db);
  const runId = opts.run ?? uuid();
  try {
    ensureRunManifest(store, runId, config, opts.hypothesis);
    const result = await generateProfiles(
      store,
      llm,
      {
        runId,
        hypothesis: opts.hypothesis,
        maxActors: opts.maxActors ? parseIntOption(opts.maxActors, "maxActors") : 0,
        platform: config.simulation.platform,
      },
      config
    );
    io.stdout(`Generated profiles for run ${runId}\n`);
    io.stdout(`  Actors: ${result.actorsCreated}\n`);
    io.stdout(`  Communities: ${result.communitiesCreated}\n`);
    io.stdout(`  Follows: ${result.followsCreated}\n`);
    io.stdout(`  Seed posts: ${result.seedPostsCreated}\n`);
  } finally {
    store.close();
  }
}

async function runPipelineCommand(
  opts: {
    db: string;
    docs: string;
    hypothesis?: string;
    rounds?: string;
    seed?: string;
    config?: string;
    run?: string;
    mock?: boolean;
  },
  io: CliIO
): Promise<void> {
  const config = getConfig(opts.config);
  if (opts.rounds) {
    const rounds = parseIntOption(opts.rounds, "rounds");
    config.simulation.totalHours = (rounds * config.simulation.minutesPerRound) / 60;
  }
  if (opts.seed !== undefined) {
    config.simulation.seed = parseIntOption(opts.seed, "seed");
  }

  const store = new SQLiteGraphStore(opts.db);
  const runId = opts.run ?? uuid();
  const llm = createPipelineLlm(config, opts.mock);

  try {
    const ingest = await ingestDirectory(store, opts.docs);
    io.stdout(`Ingested ${ingest.newDocuments} documents (${ingest.totalChunks} chunks)\n`);

    const ontology = await extractOntology(store, llm);
    const graph = await buildKnowledgeGraph(store, llm);
    io.stdout(`Analyzed corpus: ${ontology.claimsExtracted} claims, ${graph.entitiesCreated} entities\n`);

    ensureRunManifest(store, runId, config, opts.hypothesis);
    const profiles = await generateProfiles(
      store,
      llm,
      {
        runId,
        hypothesis: opts.hypothesis,
        platform: config.simulation.platform,
      },
      config
    );
    io.stdout(`Generated ${profiles.actorsCreated} actors for run ${runId}\n`);

    const backend = opts.mock
      ? new MockCognitionBackend()
      : new DirectLLMBackend(llm, store, { runId, promptVersion: getPromptVersion() });

    const result = await runSimulation({
      store,
      config,
      backend,
      runId,
    });

    io.stdout(`Pipeline ${result.status}\n`);
    io.stdout(`  Run ID: ${result.runId}\n`);
    io.stdout(`  Rounds: ${result.totalRounds}\n`);
    io.stdout(`  Graph revision: ${graph.graphRevisionId}\n`);
  } finally {
    store.close();
  }
}

function runInspectCommand(
  opts: { db: string; actor: string; run?: string; json?: boolean },
  io: CliIO
): void {
  const store = new SQLiteGraphStore(opts.db);
  try {
    const runId = opts.run ?? store.getLatestRunId();
    if (!runId) throw new Error("No runs found in database.");

    const actor = resolveActorByName(store, runId, opts.actor);
    const context = store.queryActorContext(actor.id, runId);

    if (opts.json) {
      io.stdout(JSON.stringify(context, null, 2) + "\n");
      return;
    }

    io.stdout(formatActorContext(context) + "\n");
  } finally {
    store.close();
  }
}

// ═══════════════════════════════════════════════════════
// BANNER
// ═══════════════════════════════════════════════════════

function printBanner(io: CliIO): void {
  const isTTY = process.stdout.isTTY;
  const O = isTTY ? "\x1b[33m" : "";   // orange (claws + antenna)
  const W = isTTY ? "\x1b[97m" : "";   // white  (faces)
  const C = isTTY ? "\x1b[36m" : "";   // cyan   (title)
  const D = isTTY ? "\x1b[2m" : "";    // dim    (subtitle + version)
  const B = isTTY ? "\x1b[1m" : "";    // bold
  const R = isTTY ? "\x1b[0m" : "";    // reset

  io.stdout("\n");
  io.stdout(`   ${O}◉     ◉     ◉     ◉     ◉     ◉     ◉${R}\n`);
  io.stdout(`   ${O}│     │     │     │     │     │     │${R}\n`);
  io.stdout(`  ${O}╭┴╮   ╭┴╮   ╭┴╮   ╭┴╮   ╭┴╮   ╭┴╮   ╭┴╮${R}\n`);
  io.stdout(` ${O}⌐${W}°‿°${O}¬ ⌐${W}°o°${O}¬ ⌐${W}·_·${O}¬ ⌐${W}>‿<${O}¬ ⌐${W}°‿°${O}¬ ⌐${W}°_°${O}¬ ⌐${W}ᵔ‿ᵔ${O}¬${R}\n`);
  io.stdout(`  ${O}╘═╛   ╘═╛   ╘═╛   ╘═╛   ╘═╛   ╘═╛   ╘═╛${R}\n`);
  io.stdout("\n");
  io.stdout(`         ${B}${C}S E L D O N C L A W${R}  ${D}v0.1.0${R}\n`);
  io.stdout(`   ${D}social simulation · web-grounded cognition${R}\n`);
  io.stdout("\n");
}

export function createProgram(io: CliIO = defaultIO): Command {
  const program = new Command()
    .name("seldonclaw")
    .version("0.1.0")
    .description("Social simulation engine on CKP")
    .configureOutput({
      writeOut: (text) => io.stdout(text),
      writeErr: (text) => io.stderr(text),
    })
    .hook("preAction", () => {
      printBanner(io);
    });

  // ═══════════════════════════════════════════════════════
  // SIMULATE
  // ═══════════════════════════════════════════════════════

  program
    .command("design")
    .description("Design a simulation from a natural-language brief")
    .option("--brief <text>", "natural-language simulation brief")
    .option("--docs <dir>", "documents directory to bind into the generated spec")
    .option("--config <path>", "base config YAML file")
    .option("--out-config <path>", "generated config output path", "seldonclaw.generated.config.yaml")
    .option("--out-spec <path>", "generated simulation spec path", "simulation.spec.json")
    .option("--mock", "use MockLLMClient for brief interpretation")
    .option("--yes", "write files without confirmation")
    .action(async (opts) => {
      await runDesignCommand(
        {
          ...opts,
          outConfig: opts.outConfig,
          outSpec: opts.outSpec,
        },
        io
      );
    });

  program
    .command("run")
    .description("Full pipeline: ingest -> analyze -> generate -> simulate")
    .requiredOption("--docs <dir>", "directory with source documents")
    .option("--db <path>", "SQLite database path", "simulation.db")
    .option("--hypothesis <text>", "scenario hypothesis")
    .option("--rounds <n>", "override number of rounds")
    .option("--seed <n>", "PRNG seed")
    .option("--config <path>", "config YAML file")
    .option("--run <id>", "run ID")
    .option("--mock", "use mock LLM + mock cognition backend")
    .action(async (opts) => {
      await runPipelineCommand(opts, io);
    });

  program
    .command("ingest")
    .description("Ingest documents into the knowledge graph store")
    .requiredOption("--docs <dir>", "directory with source documents")
    .option("--db <path>", "SQLite database path", "simulation.db")
    .action(async (opts) => {
      await runIngestCommand(opts, io);
    });

  program
    .command("analyze")
    .description("Extract ontology + claims and build the knowledge graph")
    .option("--db <path>", "SQLite database path", "simulation.db")
    .option("--config <path>", "config YAML file")
    .option("--mock", "use MockLLMClient")
    .action(async (opts) => {
      await runAnalyzeCommand(opts, io);
    });

  program
    .command("generate")
    .description("Generate actor profiles from the knowledge graph")
    .option("--db <path>", "SQLite database path", "simulation.db")
    .option("--run <id>", "run ID")
    .option("--config <path>", "config YAML file")
    .option("--hypothesis <text>", "scenario hypothesis")
    .option("--max-actors <n>", "cap number of generated actors")
    .option("--mock", "use MockLLMClient")
    .action(async (opts) => {
      await runGenerateCommand(
        {
          ...opts,
          maxActors: opts.maxActors,
        },
        io
      );
    });

  program
    .command("simulate")
    .description("Run simulation rounds on an existing database")
    .option("--db <path>", "SQLite database path", "simulation.db")
    .option("--rounds <n>", "override number of rounds")
    .option("--seed <n>", "PRNG seed (0=random)")
    .option("--config <path>", "config YAML file")
    .option("--run <id>", "run ID (auto-generated if omitted)")
    .option("--mock", "use MockCognitionBackend instead of DirectLLMBackend")
    .action(async (opts) => {
      await runSimulateCommand(opts, io);
    });

  // ═══════════════════════════════════════════════════════
  // STATS
  // ═══════════════════════════════════════════════════════

  program
    .command("stats")
    .description("Show simulation metrics")
    .requiredOption("--db <path>", "SQLite database path")
    .option("--tiers", "show cognition tier breakdown")
    .option("--run <id>", "specific run ID")
    .action((opts) => {
      runStatsCommand(opts, io);
    });

  // ═══════════════════════════════════════════════════════
  // INTERVIEW
  // ═══════════════════════════════════════════════════════

  program
    .command("inspect")
    .description("Inspect actor state and recent context")
    .requiredOption("--actor <name>", "actor name, handle, or ID")
    .option("--db <path>", "SQLite database path", "simulation.db")
    .option("--run <id>", "run ID")
    .option("--json", "output raw JSON context")
    .action((opts) => {
      runInspectCommand(opts, io);
    });

  program
    .command("interview")
    .description("Interview a simulated actor")
    .option("--db <path>", "SQLite database path", "simulation.db")
    .option("--actor <name>", "actor name, handle, or ID")
    .option("--run <id>", "run ID")
    .option("--question <text>", "single question (omit for REPL mode)")
    .option("--mock", "use MockCognitionBackend")
    .action(async (opts) => {
      const store = new SQLiteGraphStore(opts.db);
      try {
        const runId = opts.run ?? store.getLatestRunId();
        if (!runId) throw new Error("No runs found in database.");

        const actor = resolveActorByName(store, runId, opts.actor);
        const config = defaultConfig();
        const backend = opts.mock
          ? new MockCognitionBackend()
          : new DirectLLMBackend(
              new LLMClient(config.providers),
              store,
              { runId, promptVersion: getPromptVersion() }
            );

        await backend.start();
        try {
          const result = await interviewActor(store, runId, actor.id, backend, opts.question ?? "Tell me about yourself.");
          io.stdout(`${result.actorName}: ${result.response}\n`);
        } finally {
          await backend.shutdown();
        }
      } finally {
        store.close();
      }
    });

  // ═══════════════════════════════════════════════════════
  // EXPORT-AGENT
  // ═══════════════════════════════════════════════════════

  program
    .command("export-agent")
    .description("Export actor as CKP agent bundle")
    .option("--db <path>", "SQLite database path", "simulation.db")
    .requiredOption("--actor <name>", "actor name, handle, or ID")
    .option("--out <dir>", "output directory", "./ckp-export")
    .option("--run <id>", "run ID")
    .action((opts) => {
      const store = new SQLiteGraphStore(opts.db);
      try {
        const runId = opts.run ?? store.getLatestRunId();
        if (!runId) throw new Error("No runs found in database.");

        const actor = resolveActorByName(store, runId, opts.actor);
        const result = exportAgent(store, runId, actor.id, opts.out);
        io.stdout(`Exported ${actor.name} to ${result.outDir}\n`);
        io.stdout(`  Files: ${result.files.join(", ")}\n`);
      } finally {
        store.close();
      }
    });

  // ═══════════════════════════════════════════════════════
  // IMPORT-AGENT
  // ═══════════════════════════════════════════════════════

  program
    .command("import-agent")
    .description("Import CKP agent bundle into a run")
    .requiredOption("--bundle <dir>", "CKP bundle directory")
    .option("--db <path>", "SQLite database path", "simulation.db")
    .option("--run <id>", "run ID")
    .action((opts) => {
      const store = new SQLiteGraphStore(opts.db);
      try {
        const runId = opts.run ?? store.getLatestRunId();
        if (!runId) throw new Error("No runs found in database.");

        const result = importAgent(store, runId, opts.bundle);
        io.stdout(`Imported ${result.name} (${result.actorId})\n`);
        io.stdout(`  Topics: ${result.topicsImported}, Beliefs: ${result.beliefsImported}\n`);
      } finally {
        store.close();
      }
    });

  // ═══════════════════════════════════════════════════════
  // REPORT
  // ═══════════════════════════════════════════════════════

  program
    .command("report")
    .description("Generate simulation report")
    .requiredOption("--db <path>", "SQLite database path")
    .option("--run <id>", "run ID")
    .option("--config <path>", "config YAML file")
    .option("--mock", "use MockLLMClient for narrative generation")
    .option("--json", "output raw JSON metrics")
    .action(async (opts) => {
      const store = new SQLiteGraphStore(opts.db);
      try {
        const runId = opts.run ?? store.getLatestRunId();
        if (!runId) throw new Error("No runs found in database.");

        const config = getConfig(opts.config);
        const llm = createCliLlm(config, { mock: opts.mock, feature: "report" });
        const result = await generateReport(store, runId, llm);

        if (opts.json) {
          io.stdout(JSON.stringify(result.metrics, null, 2) + "\n");
        } else {
          io.stdout(`Report for run ${runId}\n`);
          io.stdout(`  Rounds: ${result.metrics.rounds_completed}\n`);
          io.stdout(`  Total posts: ${result.metrics.total_posts}\n`);
          io.stdout(`  Total actions: ${result.metrics.total_actions}\n`);
          io.stdout(`  Avg active actors: ${result.metrics.avg_active_actors.toFixed(1)}\n`);
          if (result.metrics.hypothesis) {
            io.stdout(`  Hypothesis: ${result.metrics.hypothesis}\n`);
          }
          if (result.narrative) {
            io.stdout(`\n${result.narrative}\n`);
          }
        }
      } finally {
        store.close();
      }
    });

  // ═══════════════════════════════════════════════════════
  // SHELL
  // ═══════════════════════════════════════════════════════

  program
    .command("shell")
    .description("Interactive conversational REPL")
    .option("--db <path>", "SQLite database path", "simulation.db")
    .option("--run <id>", "run ID")
    .option("--config <path>", "config YAML file")
    .option("--mock", "use MockCognitionBackend for interviews")
    .action(async (opts) => {
      const store = new SQLiteGraphStore(opts.db);
      try {
        const runId = opts.run ?? store.getLatestRunId();
        if (!runId) throw new Error("No runs found in database.");

        const config = getConfig(opts.config);
        const llm = createCliLlm(config, { feature: "shell" });
        const backend = opts.mock
          ? new MockCognitionBackend()
          : new DirectLLMBackend(
              llm,
              store,
              { runId, promptVersion: getPromptVersion() }
            );

        if (backend) await backend.start();

        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        try {
          await startShell(
            { store, runId, llm, backend },
            {
              prompt: (text) => rl.setPrompt(text),
              output: (text) => io.stdout(text),
              error: (text) => io.stderr(text),
              readline: () =>
                new Promise<string>((resolve, reject) => {
                  rl.prompt();
                  rl.once("line", resolve);
                  rl.once("close", () => reject(new Error("EOF")));
                }),
              close: () => rl.close(),
            }
          );
        } finally {
          if (backend) await backend.shutdown();
        }
      } finally {
        store.close();
      }
    });

  // ═══════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════

  program
    .command("init")
    .description("Initialize a new SeldonClaw project")
    .option("--output <path>", "config file output path", "seldonclaw.config.yaml")
    .option("--yes", "write defaults without interactive prompts")
    .action(async (opts) => {
      await runInitCommand(opts, io);
    });

  // ═══════════════════════════════════════════════════════
  // DOCTOR
  // ═══════════════════════════════════════════════════════

  program
    .command("doctor")
    .description("Run diagnostic checks")
    .option("--config <path>", "config file path", "seldonclaw.config.yaml")
    .action(async (opts) => {
      let passed = 0;
      let failed = 0;

      // 1. Node version
      const nodeVersion = process.versions.node;
      const majorVersion = parseInt(nodeVersion.split(".")[0], 10);
      if (majorVersion >= 18) {
        io.stdout(`  [PASS] Node.js ${nodeVersion}\n`);
        passed++;
      } else {
        io.stdout(`  [FAIL] Node.js ${nodeVersion} (need >= 18)\n`);
        failed++;
      }

      // 2. Config file
      if (existsSync(opts.config)) {
        io.stdout(`  [PASS] Config file: ${opts.config}\n`);
        passed++;

        // 3. Check env vars from config
        try {
          const config = loadConfig(opts.config);
          for (const [role, provider] of Object.entries(config.providers)) {
            if (provider && "apiKeyEnv" in provider) {
              const envVar = (provider as { apiKeyEnv: string }).apiKeyEnv;
              if (process.env[envVar]) {
                io.stdout(`  [PASS] ${role}: ${envVar} is set\n`);
                passed++;
              } else {
                io.stdout(`  [FAIL] ${role}: ${envVar} not set\n`);
                failed++;
              }
            }
          }

          if (config.search.enabled) {
            try {
              const provider = createSearchProvider(config.search);
              await checkSearchHealth(provider, config.search);
              io.stdout(`  [PASS] search: SearXNG reachable at ${config.search.endpoint}\n`);
              passed++;
            } catch (err) {
              io.stdout(
                `  [FAIL] search: SearXNG not reachable at ${config.search.endpoint} (${formatErrorMessage(err)})\n`
              );
              failed++;
            }
          }
        } catch (err) {
          io.stdout(`  [FAIL] Config parse error: ${formatErrorMessage(err)}\n`);
          failed++;
        }
      } else {
        io.stdout(`  [FAIL] Config file not found: ${opts.config}\n`);
        failed++;
      }

      // 4. SQLite test
      try {
        const testStore = new SQLiteGraphStore(":memory:");
        testStore.close();
        io.stdout(`  [PASS] SQLite (better-sqlite3)\n`);
        passed++;
      } catch (err) {
        io.stdout(`  [FAIL] SQLite: ${formatErrorMessage(err)}\n`);
        failed++;
      }

      io.stdout(`\n  ${passed} passed, ${failed} failed\n`);
    });

  // ═══════════════════════════════════════════════════════
  // STUB COMMANDS (future phases)
  // ═══════════════════════════════════════════════════════

  const stubs = [
    { name: "resume", desc: "Resume simulation from last snapshot" },
    { name: "replay", desc: "Replay simulation from decision cache" },
  ];

  for (const stub of stubs) {
    program
      .command(stub.name)
      .description(`${stub.desc} (not yet implemented)`)
      .action(() => {
        io.stdout(`"seldonclaw ${stub.name}" is not yet implemented.\n`);
      });
  }

  return program;
}

export async function runCli(argv = process.argv, io: CliIO = defaultIO): Promise<void> {
  const program = createProgram(io);
  await program.parseAsync(argv);
}

const entryHref = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : null;

if (entryHref && import.meta.url === entryHref) {
  runCli().catch((err) => {
    defaultIO.stderr(`${formatErrorMessage(err)}\n`);
    process.exitCode = 1;
  });
}
