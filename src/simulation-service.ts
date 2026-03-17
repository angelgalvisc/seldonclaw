/**
 * simulation-service.ts — Thin orchestration layer for simulation design and execution.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SQLiteGraphStore, uuid, type RunManifest } from "./db.js";
import type { SimConfig } from "./config.js";
import { sanitizeForStorage } from "./config.js";
import { DirectLLMBackend, MockCognitionBackend, getPromptVersion } from "./cognition.js";
import { runSimulation, type EngineRoundProgress } from "./engine.js";
import { LLMClient, MockLLMClient, estimateModelCost } from "./llm.js";
import { ingestDirectory } from "./ingest.js";
import { extractOntology } from "./ontology.js";
import { buildKnowledgeGraph } from "./graph.js";
import { generateProfiles } from "./profiles.js";
import { designSimulationFromBrief, type SimulationDesignResult } from "./design.js";
import type { AssistantWorkspaceLayout, AssistantSimulationRecord } from "./assistant-workspace.js";
import {
  addDurableMemory,
  appendDailyNote,
  recordSimulationHistory,
  updateSimulationHistoryRecord,
} from "./assistant-workspace.js";
import { SimulationCancelledError, throwIfStopRequested } from "./run-control.js";

export interface DesignSimulationInput {
  config: SimConfig;
  brief: string;
  llm: LLMClient;
  docsPath?: string;
  workspace?: AssistantWorkspaceLayout | null;
  operatorContext?: string | null;
}

export interface DesignedSimulationArtifacts extends SimulationDesignResult {
  specPath: string;
  configPath: string;
  artifactDir: string;
  historyRecord: AssistantSimulationRecord | null;
}

export interface PipelineCallbacks {
  onPhase?: (phase: "ingest" | "analyze" | "generate" | "simulate") => void;
  onRound?: (progress: EngineRoundProgress) => void;
}

export interface ExecutePipelineInput {
  config: SimConfig;
  dbPath: string;
  docsPath: string;
  runId?: string;
  hypothesis?: string | null;
  actorCount?: number | null;
  focusActors?: string[];
  /** Cast design from the design layer (cast seeds, community proposals, entity type hints) */
  castDesign?: import("./design.js").CastDesign;
  mock?: boolean;
  callbacks?: PipelineCallbacks;
  signal?: AbortSignal;
  shouldStop?: () => boolean;
}

export interface PipelineExecutionResult {
  runId: string;
  dbPath: string;
  totalRounds: number;
  completedRounds: number;
  status: "completed" | "failed" | "cancelled";
  graphRevisionId: string;
  actorsCreated: number;
  claimsExtracted: number;
  entitiesCreated: number;
  failureMessage?: string | null;
}

export interface RunEstimate {
  rounds: number;
  estimatedMinutes: number;
  estimatedTokens: number;
  estimatedCostUsd: number | null;
  searchEnabled: boolean;
}

export function createFeatureLlm(
  config: SimConfig,
  options: { mock?: boolean; feature?: "report" | "shell" | "design" | "assistant" } = {}
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
          sourceUrls: [],
          actorCount: null,
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
    if (options.feature === "shell") {
      llm.setResponse("how many actors", "SELECT COUNT(*) as total FROM actors");
      llm.setResponse("count actors", "SELECT COUNT(*) as total FROM actors");
      llm.setResponse("list actors", "SELECT name, handle, cognition_tier FROM actors ORDER BY name LIMIT 10");
      llm.setResponse("show actors", "SELECT name, handle, cognition_tier FROM actors ORDER BY name LIMIT 10");
      llm.setResponse("how many posts", "SELECT COUNT(*) as total FROM posts");
      llm.setResponse("count posts", "SELECT COUNT(*) as total FROM posts");
      llm.setResponse("latest posts", "SELECT author_id, content, round_num FROM posts ORDER BY round_num DESC, id DESC LIMIT 10");
      llm.setResponse("recent posts", "SELECT author_id, content, round_num FROM posts ORDER BY round_num DESC, id DESC LIMIT 10");
    }
    return llm;
  }
  return new LLMClient(config.providers);
}

export function createPipelineLlm(config: SimConfig, mock?: boolean): LLMClient {
  return mock ? createPipelineMockLlm() : new LLMClient(config.providers);
}

export async function designSimulationArtifacts(
  input: DesignSimulationInput
): Promise<DesignedSimulationArtifacts> {
  const result = await designSimulationFromBrief(input.llm, input.brief, {
    docsPath: input.docsPath,
    baseConfig: input.config,
  });

  const tempDir = mkdtempSync(join(tmpdir(), "publicmachina-design-"));
  const tempSpecPath = join(tempDir, "simulation.spec.json");
  const tempConfigPath = join(tempDir, "publicmachina.generated.config.yaml");
  writeFileSync(tempSpecPath, `${JSON.stringify(result.spec, null, 2)}\n`, "utf-8");
  writeFileSync(tempConfigPath, result.yaml, "utf-8");

  let specPath = tempSpecPath;
  let configPath = tempConfigPath;
  let artifactDir = tempDir;
  let historyRecord: AssistantSimulationRecord | null = null;

  try {
    if (input.workspace) {
      historyRecord = recordSimulationHistory(input.workspace, {
        title: result.spec.title,
        objective: result.spec.objective,
        hypothesis: result.spec.hypothesis,
        brief: input.brief,
        context: input.operatorContext ?? null,
        specPath: tempSpecPath,
        configPath: tempConfigPath,
        docsPath: result.spec.docsPath,
        tags: result.spec.focusActors,
      });
      specPath = historyRecord.specPath ?? tempSpecPath;
      configPath = historyRecord.configPath ?? tempConfigPath;
      artifactDir = historyRecord.workspaceDir;
      appendDailyNote(input.workspace, {
        title: `Simulation design — ${result.spec.title}`,
        lines: [
          `Objective: ${result.spec.objective}`,
          `Hypothesis: ${result.spec.hypothesis ?? "not provided"}`,
          `Docs path: ${result.spec.docsPath ?? "not provided"}`,
        ],
      });
      addDurableMemory(input.workspace, {
        kind: "simulation",
        summary: `Designed simulation "${result.spec.title}" with objective: ${result.spec.objective}`,
        tags: result.spec.focusActors,
      });
    } else {
      const fallbackDir = resolve(process.cwd(), input.config.output.dir, slugify(result.spec.title));
      mkdirSync(fallbackDir, { recursive: true });
      specPath = join(fallbackDir, "simulation.spec.json");
      configPath = join(fallbackDir, "publicmachina.generated.config.yaml");
      artifactDir = fallbackDir;
      writeFileSync(specPath, readFileSync(tempSpecPath, "utf-8"), "utf-8");
      writeFileSync(configPath, readFileSync(tempConfigPath, "utf-8"), "utf-8");
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  return {
    ...result,
    specPath,
    configPath,
    artifactDir,
    historyRecord,
  };
}

export async function executePipeline(
  input: ExecutePipelineInput
): Promise<PipelineExecutionResult> {
  const config = structuredClone(input.config);
  const store = new SQLiteGraphStore(input.dbPath);
  const runId = input.runId ?? uuid();
  const llm = createPipelineLlm(config, input.mock);
  let claimsExtracted = 0;
  let entitiesCreated = 0;
  let actorsCreated = 0;

  try {
    throwIfStopRequested({
      signal: input.signal,
      shouldStop: input.shouldStop,
      message: "Simulation stop requested before ingestion.",
    });
    input.callbacks?.onPhase?.("ingest");
    const ingest = await ingestDirectory(store, input.docsPath);

    throwIfStopRequested({
      signal: input.signal,
      shouldStop: input.shouldStop,
      message: "Simulation stop requested before analysis.",
    });
    input.callbacks?.onPhase?.("analyze");
    const ontology = await extractOntology(store, llm, {
      pipelineConcurrency: config.simulation.pipelineConcurrency,
    });
    const graph = await buildKnowledgeGraph(store, llm, {
      entityTypeHints: input.castDesign?.entityTypeHints,
    });
    claimsExtracted = ontology.claimsExtracted;
    entitiesCreated = graph.entitiesCreated;

    throwIfStopRequested({
      signal: input.signal,
      shouldStop: input.shouldStop,
      message: "Simulation stop requested before profile generation.",
    });
    input.callbacks?.onPhase?.("generate");
    ensureRunManifest(store, runId, config, input.hypothesis ?? undefined);
    const profiles = await generateProfiles(
      store,
      llm,
      {
        runId,
        hypothesis: input.hypothesis ?? undefined,
        maxActors: input.actorCount ?? 0,
        focusActors: input.focusActors ?? [],
        castSeeds: input.castDesign?.castSeeds,
        communityProposals: input.castDesign?.communityProposals,
        pipelineConcurrency: config.simulation.pipelineConcurrency,
        platform: config.simulation.platform,
      },
      config
    );
    actorsCreated = profiles.actorsCreated;

    throwIfStopRequested({
      signal: input.signal,
      shouldStop: input.shouldStop,
      message: "Simulation stop requested before the simulation engine started.",
    });
    // Inject cast seed names into search allowActors so search activation works
    if (input.castDesign?.castSeeds?.length) {
      const castNames = input.castDesign.castSeeds.map((s) => s.name);
      const existing = new Set(config.search.allowActors.map((a) => a.toLowerCase()));
      for (const name of castNames) {
        if (!existing.has(name.toLowerCase())) {
          config.search.allowActors.push(name);
        }
      }
    }

    input.callbacks?.onPhase?.("simulate");
    const backend = input.mock
      ? new MockCognitionBackend()
      : new DirectLLMBackend(llm, store, { runId, promptVersion: getPromptVersion() });
    const result = await runSimulation({
      store,
      config,
      backend,
      runId,
      signal: input.signal,
      shouldStop: input.shouldStop,
      callbacks: {
        onRoundComplete: (progress) => input.callbacks?.onRound?.(progress),
      },
    });

    return {
      runId: result.runId,
      dbPath: input.dbPath,
      totalRounds: result.totalRounds,
      completedRounds: result.completedRounds,
      status: result.status,
      graphRevisionId: graph.graphRevisionId,
      actorsCreated,
      claimsExtracted,
      entitiesCreated,
      failureMessage: result.failureMessage ?? null,
    };
  } catch (err) {
    if (err instanceof SimulationCancelledError) {
      const existingRun = store.getRun(runId);
      if (existingRun) {
        store.updateRun(runId, {
          status: "cancelled",
          finished_at: new Date().toISOString(),
        });
      }
      return {
        runId,
        dbPath: input.dbPath,
        totalRounds: Math.max(
          1,
          Math.round((config.simulation.totalHours * 60) / config.simulation.minutesPerRound)
        ),
        completedRounds: 0,
        status: "cancelled",
        graphRevisionId: store.computeGraphRevisionId(),
        actorsCreated,
        claimsExtracted,
        entitiesCreated,
        failureMessage: null,
      };
    }
    throw err;
  } finally {
    store.close();
  }
}

export function estimatePipelineRun(config: SimConfig): RunEstimate {
  const rounds = Math.max(
    1,
    Math.round((config.simulation.totalHours * 60) / config.simulation.minutesPerRound)
  );
  const estimatedMinutes = Math.max(1, Math.round(rounds * 0.35));
  const estimatedTokens = rounds * (config.search.enabled ? 4200 : 2800);
  const simulationModel = config.providers.default.model;
  const estimatedCostUsd = estimateModelCost(
    simulationModel,
    Math.round(estimatedTokens * 0.65),
    Math.round(estimatedTokens * 0.35)
  );

  return {
    rounds,
    estimatedMinutes,
    estimatedTokens,
    estimatedCostUsd,
    searchEnabled: config.search.enabled,
  };
}

export function persistCompletedRunHistory(
  workspace: AssistantWorkspaceLayout | null | undefined,
  historyRecordId: string | null,
  update: {
    objective?: string | null;
    hypothesis?: string | null;
    docsPath?: string | null;
    dbPath?: string | null;
    runId?: string | null;
    reportPath?: string | null;
    tags?: string[];
  }
): void {
  if (!workspace || !historyRecordId) return;
  updateSimulationHistoryRecord(workspace, historyRecordId, update);
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

export function ensureRunManifest(
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

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "simulation";
}
