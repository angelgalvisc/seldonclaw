/**
 * assistant-tools.ts — Typed tools for the PublicMachina operator planner.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SQLiteGraphStore, uuid } from "./db.js";
import type { SimConfig } from "./config.js";
import { loadConfig } from "./config.js";
import type { AssistantWorkspaceLayout } from "./assistant-workspace.js";
import {
  appendDailyNote,
  assertPathInsideWorkspace,
  ensureWorkspaceOutputDir,
  getSimulationHistoryRecord,
  listSimulationHistory,
  updateSimulationHistoryRecord,
} from "./assistant-workspace.js";
import type {
  AssistantTaskState,
  DesignedSimulationState,
  PendingRunConfirmation,
} from "./assistant-state.js";
import {
  addSessionUsage,
  setCancelledRunState,
  setCancellingRunState,
  setActiveRunState,
  setCompletedRunState,
  setDesignedSimulationState,
  setFailedRunState,
  setPendingRunConfirmation,
  updateActiveRunProgress,
} from "./assistant-state.js";
import type { LLMClient } from "./llm.js";
import { generateReport } from "./report.js";
import { exportAgent } from "./ckp.js";
import { resolveActorByName, interviewActor } from "./interview.js";
import {
  createFeatureLlm,
  designSimulationArtifacts,
  estimatePipelineRun,
  executePipeline,
  persistCompletedRunHistory,
} from "./simulation-service.js";
import { MockCognitionBackend, DirectLLMBackend, getPromptVersion } from "./cognition.js";
import { executeQuery, extractSchema, formatTable, nlToSql } from "./query-service.js";
import {
  createProviderConfig,
  resolveProviderConfig,
  setGlobalProviderSelection,
  setRoleProviderSelection,
  type ProviderRole,
} from "./provider-selection.js";
import {
  describeConfiguredModel,
  getProviderCatalog,
  normalizeModelId,
  parseProvider,
  resolveModelPreset,
  type SupportedProvider,
} from "./model-catalog.js";
import { saveConfig } from "./config.js";
import { formatSimulationPlan, validateSimulationSpec } from "./design.js";
import { designCast } from "./cast-design.js";
import {
  acquireActiveRunLock,
  clearStopRequest,
  createGracefulStopController,
  releaseActiveRunLock,
  readStopRequest,
  stopRequestAppliesToRun,
  writeStopRequest,
} from "./run-control.js";

export type AssistantToolName =
  | "design_simulation"
  | "run_simulation"
  | "stop_simulation"
  | "query_simulation"
  | "interview_actor"
  | "generate_report"
  | "list_history"
  | "export_agent"
  | "switch_provider";

export interface AssistantToolDefinition {
  name: AssistantToolName;
  description: string;
  parameters: Record<string, string>;
}

export interface AssistantToolRuntime {
  config: SimConfig;
  configPath: string;
  workspace: AssistantWorkspaceLayout;
  taskState: AssistantTaskState;
  mock?: boolean;
  updateConfig: (config: SimConfig) => Promise<void>;
  updateTaskState: (nextState: AssistantTaskState) => void;
  onProgress?: (message: string) => void;
}

export interface AssistantToolResult {
  status: "completed" | "needs_confirmation" | "error";
  summary: string;
  details?: string;
  pendingRun?: PendingRunConfirmation;
}

export const ASSISTANT_TOOLS: AssistantToolDefinition[] = [
  {
    name: "design_simulation",
    description:
      "Use this when the user wants to create, redesign, replace, or refine a simulation from a natural-language brief. This tool turns the brief into persisted spec/config artifacts and should be preferred over free-form discussion once the user has provided enough concrete scenario detail.",
    parameters: {
      brief: "string — the scenario brief, constraints, URLs, and desired outputs",
      docsPath: "string? — optional local documents path when the user explicitly references local files",
    },
  },
  {
    name: "run_simulation",
    description:
      "Use this only after a simulation has already been designed and the user explicitly wants to execute it. This tool has side effects, requires confirmation before execution, and should not be called while another run is active in the same workspace.",
    parameters: {
      specPath: "string? — explicit generated simulation spec path when not using the active design",
      configPath: "string? — explicit generated config path when not using the active design",
      docsPath: "string? — source documents path override when the active design should not be used as-is",
      confirmed: "boolean? — true only after the user has explicitly confirmed the run",
    },
  },
  {
    name: "stop_simulation",
    description:
      "Use this to request a graceful stop for the currently running simulation. It should only be used when a run is active or cancelling, and it preserves database consistency by stopping at safe checkpoints instead of killing the process abruptly.",
    parameters: {
      runId: "string? — explicit run ID if you need to stop a specific run",
    },
  },
  {
    name: "query_simulation",
    description:
      "Use this after a run exists and the user wants analytical answers from the simulation database. The tool accepts either a natural-language question or a raw SELECT statement and should not be used before a runnable database target is available.",
    parameters: {
      question: "string — analytical question or raw SELECT statement",
      dbPath: "string? — explicit SQLite path",
      runId: "string? — explicit run ID inside that database",
    },
  },
  {
    name: "interview_actor",
    description:
      "Use this after a run completes when the user wants a simulated actor to explain their reasoning, motives, or memories. It requires a completed or cancelled run target plus an actor identifier and should not be used during early design.",
    parameters: {
      actorName: "string — actor name, handle, or ID",
      question: "string — what to ask the actor",
      dbPath: "string? — explicit SQLite path",
      runId: "string? — explicit run ID",
    },
  },
  {
    name: "generate_report",
    description:
      "Use this after a run completes when the user wants a written synthesis of outcomes, metrics, and narrative evolution. It should not be used before a completed or cancelled run target exists.",
    parameters: {
      dbPath: "string? — explicit SQLite path",
      runId: "string? — explicit run ID",
    },
  },
  {
    name: "list_history",
    description:
      "Use this when the user wants to see remembered simulations, find a prior run, or recover context from earlier work. It is safe, read-only, and available in every operator state.",
    parameters: {
      query: "string? — optional keyword filter",
    },
  },
  {
    name: "export_agent",
    description:
      "Use this after a run completes when the user wants to export an evolved actor as a CKP bundle. It requires a completed or cancelled run target plus an actor identifier and writes files inside the workspace only.",
    parameters: {
      actorName: "string — actor name, handle, or ID",
      outDir: "string? — export directory",
      dbPath: "string? — explicit SQLite path",
      runId: "string? — explicit run ID",
    },
  },
  {
    name: "switch_provider",
    description:
      "Use this when the user explicitly asks to inspect or change the current provider or model. It can change the global default or a role-specific override, including the dedicated assistant planner role.",
    parameters: {
      provider: "string? — anthropic, openai, or moonshot",
      model: "string? — provider model ID or friendly label",
      role: "string? — analysis, generation, simulation, report, or assistant",
    },
  },
];

export function getAvailableAssistantTools(taskState: AssistantTaskState): AssistantToolDefinition[] {
  const alwaysAvailable = new Set<AssistantToolName>([
    "design_simulation",
    "list_history",
    "switch_provider",
  ]);
  const available = new Set<AssistantToolName>(alwaysAvailable);

  if (taskState.activeDesign && ["designed", "awaiting_confirmation"].includes(taskState.status)) {
    available.add("run_simulation");
  }

  if (taskState.activeRun && ["running", "cancelling"].includes(taskState.status)) {
    available.add("stop_simulation");
  }

  if (taskState.lastCompletedRun || taskState.lastCancelledRun) {
    available.add("query_simulation");
    available.add("interview_actor");
    available.add("generate_report");
    available.add("export_agent");
  }

  return ASSISTANT_TOOLS.filter((tool) => available.has(tool.name));
}

export async function executeAssistantTool(
  tool: AssistantToolName,
  args: Record<string, unknown>,
  runtime: AssistantToolRuntime
): Promise<AssistantToolResult> {
  try {
    switch (tool) {
      case "design_simulation":
        return await designSimulationTool(args, runtime);
      case "run_simulation":
        return await runSimulationTool(args, runtime);
      case "stop_simulation":
        return await stopSimulationTool(args, runtime);
      case "query_simulation":
        return await querySimulationTool(args, runtime);
      case "interview_actor":
        return await interviewActorTool(args, runtime);
      case "generate_report":
        return await generateReportTool(args, runtime);
      case "list_history":
        return await listHistoryTool(args, runtime);
      case "export_agent":
        return await exportAgentTool(args, runtime);
      case "switch_provider":
        return await switchProviderTool(args, runtime);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool execution failed.";
    return {
      status: "error",
      summary: `Tool ${tool} failed.`,
      details: message,
    };
  }
}

async function designSimulationTool(
  args: Record<string, unknown>,
  runtime: AssistantToolRuntime
): Promise<AssistantToolResult> {
  const brief = stringifyArg(args.brief);
  if (!brief) {
    return {
      status: "error",
      summary: "Design failed because no simulation brief was provided.",
    };
  }

  const llm = createFeatureLlm(runtime.config, { mock: runtime.mock, feature: "design" });
  const result = await designSimulationArtifacts({
    config: runtime.config,
    brief,
    llm,
    docsPath: stringifyArg(args.docsPath) ?? undefined,
    workspace: runtime.workspace,
  });

  const materializedDocs =
    result.spec.docsPath
      ? {
          docsPath: result.spec.docsPath,
          referencedUrlCount: result.spec.sourceUrls.length,
          downloadedCount: 0,
          warnings: [] as string[],
        }
      : await materializeSourceDocs(runtime.workspace, {
      title: result.spec.title,
      objective: result.spec.objective,
      hypothesis: result.spec.hypothesis,
      sourceUrls: result.spec.sourceUrls,
      artifactDir: result.historyRecord?.workspaceDir ?? result.artifactDir,
    });
  const docsPath = materializedDocs.docsPath;

  if (docsPath !== result.spec.docsPath) {
    persistDesignedDocsPath(result.specPath, docsPath);
    if (result.historyRecord) {
      updateSimulationHistoryRecord(runtime.workspace, result.historyRecord.id, { docsPath });
    }
  }

  // Cast-design pass: runs AFTER source docs are available
  const docSummaries = readSourceDocSummaries(docsPath);
  const castDesign = await designCast(llm, {
    spec: {
      title: result.spec.title,
      objective: result.spec.objective,
      hypothesis: result.spec.hypothesis,
      focusActors: result.spec.focusActors,
    },
    sourceDocSummaries: docSummaries,
  });

  // Persist cast design into the spec file
  persistCastDesign(result.specPath, castDesign);

  const designState: DesignedSimulationState = {
    title: result.spec.title,
    brief,
    objective: result.spec.objective,
    hypothesis: result.spec.hypothesis,
    docsPath,
    actorCount: result.spec.actorCount,
    specPath: result.specPath,
    configPath: result.configPath,
    historyRecordId: result.historyRecord?.id ?? null,
    workspaceDir: result.historyRecord?.workspaceDir ?? result.artifactDir,
    rounds: result.spec.rounds,
  };
  runtime.updateTaskState(setDesignedSimulationState(runtime.workspace, designState));

  const preview = formatSimulationPlan(
    {
      ...result.spec,
      docsPath,
    },
    validateSimulationSpec({
      ...result.spec,
      docsPath,
    })
  );

  return {
    status: "completed",
    summary: `Designed "${result.spec.title}" and saved artifacts.`,
    details: [
      preview.trim(),
      `Spec: ${result.specPath}`,
      `Config: ${result.configPath}`,
      `Source docs: ${docsPath}`,
      materializedDocs.referencedUrlCount > 0
        ? `Downloaded source documents: ${materializedDocs.downloadedCount}/${materializedDocs.referencedUrlCount}`
        : "Downloaded source documents: 0",
      ...materializedDocs.warnings.map((warning) => `Warning: ${warning}`),
      castDesign.castSeeds.length > 0
        ? `Cast seeds: ${castDesign.castSeeds.length} actors proposed`
        : "Cast seeds: 0 (will use graph entities only)",
      castDesign.communityProposals.length > 0
        ? `Communities: ${castDesign.communityProposals.map((c) => c.name).join(", ")}`
        : "Communities: auto-detected from topics",
      `Next step available: run_simulation`,
    ].join("\n"),
  };
}

async function runSimulationTool(
  args: Record<string, unknown>,
  runtime: AssistantToolRuntime
): Promise<AssistantToolResult> {
  const designed = resolveDesignedSimulation(runtime, args);
  if (!designed) {
    return {
      status: "error",
      summary: "I do not have a designed simulation ready to run yet. Design one first.",
    };
  }

  const configPath = stringifyArg(args.configPath) ?? designed.configPath;
  const specPath = stringifyArg(args.specPath) ?? designed.specPath;
  const docsPath = stringifyArg(args.docsPath) ?? designed.docsPath;
  if (!docsPath) {
    return {
      status: "error",
      summary: "I need a documents path before I can run this simulation.",
      details: "Design again with docsPath or tell me where the source documents live.",
    };
  }

  const runConfig = loadConfig(configPath);
  const estimate = estimatePipelineRun(runConfig);
  if (wouldExceedSessionBudget(runtime, estimate.estimatedCostUsd ?? 0)) {
    return {
      status: "error",
      summary: "Running this simulation would exceed the current operator session budget.",
      details: renderBudgetMessage(runtime, estimate.estimatedCostUsd ?? 0),
    };
  }
  const dbPath = join(dirname(configPath), "simulation.db");
  const runId = uuid();
  const pendingRun: PendingRunConfirmation = {
    specPath,
    configPath,
    docsPath,
    dbPath,
    runId,
    historyRecordId: designed.historyRecordId,
    estimate,
  };

  if (args.confirmed !== true) {
    runtime.updateTaskState(setPendingRunConfirmation(runtime.workspace, pendingRun));
    return {
      status: "needs_confirmation",
      summary: `Ready to run "${designed.title}".`,
      details: [
        `This will run ${estimate.rounds} rounds and should take about ${estimate.estimatedMinutes} minutes.`,
        estimate.estimatedCostUsd !== null
          ? `Rough model cost estimate: ~$${estimate.estimatedCostUsd.toFixed(2)}.`
          : "Cost estimate unavailable for the current provider.",
        estimate.searchEnabled ? "Internet-enabled agents are active in this config." : "Internet search is off in this config.",
        "Reply yes to run it now, or no to keep the design without running.",
      ].join(" "),
      pendingRun,
    };
  }

  if (runtime.taskState?.activeRun && ["running", "cancelling"].includes(runtime.taskState.status)) {
    return {
      status: "error",
      summary: `Another simulation is already active in this workspace (${runtime.taskState.activeRun.runId}).`,
      details: "Stop it or wait for it to finish before starting a new run.",
    };
  }

  if (runtime.config.assistant.limits.maxConcurrentRuns <= 1) {
    acquireActiveRunLock(runtime.workspace, {
      runId,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      source: "assistant",
    });
  }

  clearStopRequest(runtime.workspace);
  const startedAt = new Date().toISOString();
  runtime.updateTaskState(
    setActiveRunState(runtime.workspace, {
      title: designed.title,
      runId,
      dbPath,
      historyRecordId: designed.historyRecordId,
      totalRounds: estimate.rounds,
      roundsCompleted: 0,
      startedAt,
    })
  );
  const phases: string[] = [];
  const stopController = createGracefulStopController(
    {
      stderr: (text) => runtime.onProgress?.(text.trim()),
    },
    () => {
      writeStopRequest(runtime.workspace, {
        requestedAt: new Date().toISOString(),
        source: "signal",
        runId,
        reason: "SIGINT",
      });
      runtime.updateTaskState(setCancellingRunState(runtime.workspace));
      runtime.onProgress?.("Graceful stop requested. PublicMachina will stop after the current safe checkpoint.");
    }
  );

  try {
    runtime.updateTaskState(addSessionUsage(runtime.workspace, {
      costUsd: estimate.estimatedCostUsd ?? 0,
    }));
    const result = await executePipeline({
      config: runConfig,
      dbPath,
      docsPath,
      runId,
      hypothesis: designed.hypothesis,
      actorCount: designed.actorCount,
      focusActors: readSpecFocusActors(specPath),
      castDesign: readSpecCastDesign(specPath),
      mock: runtime.mock,
      signal: stopController.signal,
      shouldStop: () => stopRequestAppliesToRun(readStopRequest(runtime.workspace), runId),
      callbacks: {
        onPhase: (phase) => {
          phases.push(phase);
          runtime.onProgress?.(`Phase: ${phase}`);
        },
        onRound: (progress) => {
          runtime.updateTaskState(updateActiveRunProgress(runtime.workspace, progress.roundNum + 1));
          if (
            progress.roundNum === 0 ||
            progress.roundNum + 1 === progress.totalRounds ||
            (progress.roundNum + 1) % 10 === 0
          ) {
            runtime.onProgress?.(
              `Round ${progress.roundNum + 1}/${progress.totalRounds} complete (${progress.totalActions} actions, ${progress.totalPosts} posts).`
            );
          }
        },
      },
    });

    persistCompletedRunHistory(runtime.workspace, designed.historyRecordId, {
      objective: designed.objective,
      hypothesis: designed.hypothesis,
      docsPath,
      dbPath,
      runId: result.runId,
      tags: [],
    });
    if (designed.historyRecordId) {
      appendDailyNote(runtime.workspace, {
        title: `Simulation run — ${designed.title}`,
        lines: [
          `Run ID: ${result.runId}`,
          `Database: ${dbPath}`,
          `Status: ${result.status}`,
          `Phases: ${phases.join(", ")}`,
        ],
      });
    }

    if (result.status === "failed") {
      const failureMessage = result.failureMessage ?? "Simulation failed before completion.";
      runtime.updateTaskState(
        setFailedRunState(runtime.workspace, {
          title: designed.title,
          runId: result.runId,
          dbPath,
          message: failureMessage,
          failedAt: new Date().toISOString(),
        })
      );
      return {
        status: "error",
        summary: `Simulation "${designed.title}" failed.`,
        details: [
          `Run ID: ${result.runId}`,
          `Database: ${dbPath}`,
          `Failure: ${failureMessage}`,
        ].join("\n"),
      };
    }

    if (result.status === "cancelled") {
      const stopRequest = readStopRequest(runtime.workspace);
      runtime.updateTaskState(
        setCancelledRunState(runtime.workspace, {
          title: designed.title,
          runId: result.runId,
          dbPath,
          historyRecordId: designed.historyRecordId,
          totalRounds: result.totalRounds,
          roundsCompleted: result.completedRounds,
          startedAt,
          finishedAt: new Date().toISOString(),
          reason: stopRequest?.reason ?? "Stop requested by the operator.",
        })
      );
      return {
        status: "completed",
        summary: `Simulation "${designed.title}" stopped cleanly.`,
        details: [
          `Run ID: ${result.runId}`,
          `Database: ${dbPath}`,
          `Completed rounds: ${result.completedRounds}/${result.totalRounds}`,
        ].join("\n"),
      };
    }

    runtime.updateTaskState(
      setCompletedRunState(runtime.workspace, {
        title: designed.title,
        runId: result.runId,
        dbPath,
        historyRecordId: designed.historyRecordId,
        totalRounds: result.totalRounds,
        roundsCompleted: result.completedRounds,
        startedAt,
        finishedAt: new Date().toISOString(),
      })
    );

    return {
      status: "completed",
      summary: `Simulation "${designed.title}" completed.`,
      details: [
        `Run ID: ${result.runId}`,
        `Database: ${dbPath}`,
        `Rounds: ${result.totalRounds}`,
        `Graph revision: ${result.graphRevisionId}`,
      ].join("\n"),
    };
  } finally {
    clearStopRequest(runtime.workspace);
    if (runtime.config.assistant.limits.maxConcurrentRuns <= 1) {
      releaseActiveRunLock(runtime.workspace, runId);
    }
    stopController.cleanup();
  }
}

async function stopSimulationTool(
  args: Record<string, unknown>,
  runtime: AssistantToolRuntime
): Promise<AssistantToolResult> {
  const activeRun = runtime.taskState?.activeRun;
  if (!activeRun) {
    return {
      status: "completed",
      summary: "There is no active simulation run to stop right now.",
    };
  }

  const requestedRunId = stringifyArg(args.runId);
  if (requestedRunId && requestedRunId !== activeRun.runId) {
    return {
      status: "error",
      summary: `The active run is ${activeRun.runId}, not ${requestedRunId}.`,
    };
  }

  if (runtime.taskState?.status === "cancelling") {
    return {
      status: "completed",
      summary: `A stop has already been requested for run ${activeRun.runId}.`,
    };
  }

  writeStopRequest(runtime.workspace, {
    requestedAt: new Date().toISOString(),
    source: "assistant",
    runId: activeRun.runId,
    reason: "Requested from the operator.",
  });
  runtime.updateTaskState(setCancellingRunState(runtime.workspace));
  return {
    status: "completed",
    summary: `Stop requested for run ${activeRun.runId}.`,
    details: "PublicMachina will stop after the current safe checkpoint and keep partial results.",
  };
}

async function querySimulationTool(
  args: Record<string, unknown>,
  runtime: AssistantToolRuntime
): Promise<AssistantToolResult> {
  const question = stringifyArg(args.question);
  if (!question) {
    return { status: "error", summary: "I need a question to query the simulation." };
  }

  const target = resolveRunTarget(runtime, args);
  if (!target) {
    return {
      status: "error",
      summary: "I do not know which simulation database to query yet.",
    };
  }

  const store = new SQLiteGraphStore(target.dbPath);
  try {
    let sql = question;
    if (!/^\s*SELECT\b/i.test(question)) {
      const llm = createFeatureLlm(runtime.config, { mock: runtime.mock, feature: "shell" });
      sql = await nlToSql(llm, extractSchema(store), question);
    }
    const { columns, rows } = executeQuery(store, sql);
    return {
      status: "completed",
      summary: `Queried simulation ${target.runId ?? "latest"} and returned ${rows.length} rows.`,
      details: `SQL: ${sql}\n${formatTable(columns, rows)}(${rows.length} rows)`,
    };
  } finally {
    store.close();
  }
}

async function interviewActorTool(
  args: Record<string, unknown>,
  runtime: AssistantToolRuntime
): Promise<AssistantToolResult> {
  const actorName = stringifyArg(args.actorName);
  const question = stringifyArg(args.question);
  if (!actorName || !question) {
    return {
      status: "error",
      summary: "I need both the actor name and the interview question.",
    };
  }

  const target = resolveRunTarget(runtime, args);
  if (!target) {
    return { status: "error", summary: "I do not have a completed run to interview yet." };
  }

  const store = new SQLiteGraphStore(target.dbPath);
  const llm = createFeatureLlm(runtime.config, { mock: runtime.mock, feature: "assistant" });
  const backend = runtime.mock
    ? new MockCognitionBackend()
    : new DirectLLMBackend(llm, store, { runId: target.runId, promptVersion: getPromptVersion() });

  try {
    await backend.start();
    const actor = resolveActorByName(store, target.runId, actorName);
    const result = await interviewActor(store, target.runId, actor.id, backend, question);
    return {
      status: "completed",
      summary: `Interviewed ${result.actorName}.`,
      details: `${result.actorName}: ${result.response}`,
    };
  } finally {
    await backend.shutdown();
    store.close();
  }
}

async function generateReportTool(
  args: Record<string, unknown>,
  runtime: AssistantToolRuntime
): Promise<AssistantToolResult> {
  const target = resolveRunTarget(runtime, args);
  if (!target) {
    return { status: "error", summary: "I do not have a completed run to report on yet." };
  }

  const store = new SQLiteGraphStore(target.dbPath);
  try {
    const llm = createFeatureLlm(runtime.config, { mock: runtime.mock, feature: "report" });
    const result = await generateReport(store, target.runId, llm);
    const historyRecord = target.historyRecordId
      ? getSimulationHistoryRecord(runtime.workspace, target.historyRecordId)
      : null;
    const reportDir = historyRecord
      ? historyRecord.workspaceDir
      : ensureWorkspaceOutputDir(runtime.workspace, "exports", "reports", target.runId);
    const reportPath = assertPathInsideWorkspace(
      runtime.workspace,
      join(reportDir, "report.md"),
      "Report output must stay inside the workspace."
    );
    const lines = [
      `# Report for run ${target.runId}`,
      "",
      `- Rounds: ${result.metrics.rounds_completed}`,
      `- Total posts: ${result.metrics.total_posts}`,
      `- Total actions: ${result.metrics.total_actions}`,
      `- Avg active actors: ${result.metrics.avg_active_actors.toFixed(1)}`,
      "",
      result.narrative ?? "No narrative generated.",
      "",
    ];
    writeFileSync(reportPath, lines.join("\n"), "utf-8");

    if (runtime.workspace && target.historyRecordId) {
      updateSimulationHistoryRecord(runtime.workspace, target.historyRecordId, { reportPath });
    }

    return {
      status: "completed",
      summary: `Generated a report for run ${target.runId}.`,
      details: `Report: ${reportPath}\n\n${result.narrative ?? "No narrative generated."}`,
    };
  } finally {
    store.close();
  }
}

async function listHistoryTool(
  args: Record<string, unknown>,
  runtime: AssistantToolRuntime
): Promise<AssistantToolResult> {
  const query = stringifyArg(args.query) ?? undefined;
  const history = listSimulationHistory(runtime.workspace, { query, limit: 10 });
  if (history.length === 0) {
    return {
      status: "completed",
      summary: "No previous simulations matched that query.",
    };
  }

  return {
    status: "completed",
    summary: `Found ${history.length} previous simulations.`,
    details: history
      .map((record) =>
        [
          `- ${record.title}`,
          `  Created: ${record.createdAt}`,
          `  Objective: ${record.objective ?? "not captured"}`,
          `  Run ID: ${record.runId ?? "not run yet"}`,
        ].join("\n")
      )
      .join("\n"),
  };
}

async function exportAgentTool(
  args: Record<string, unknown>,
  runtime: AssistantToolRuntime
): Promise<AssistantToolResult> {
  const actorName = stringifyArg(args.actorName);
  if (!actorName) {
    return { status: "error", summary: "I need the actor name to export." };
  }

  const target = resolveRunTarget(runtime, args);
  if (!target) {
    return { status: "error", summary: "I do not have a completed run to export from yet." };
  }

  const store = new SQLiteGraphStore(target.dbPath);
  try {
    const actor = resolveActorByName(store, target.runId, actorName);
    const requestedOutDir = stringifyArg(args.outDir);
    const defaultOutDir = ensureWorkspaceOutputDir(
      runtime.workspace,
      "exports",
      "ckp",
      target.runId,
      actor.handle?.replace(/^@/, "") || actor.id
    );
    const outDir = requestedOutDir
      ? assertPathInsideWorkspace(
          runtime.workspace,
          requestedOutDir,
          "CKP export output must stay inside the workspace."
        )
      : defaultOutDir;
    const result = exportAgent(store, target.runId, actor.id, outDir);
    return {
      status: "completed",
      summary: `Exported ${actor.name} as a CKP bundle.`,
      details: `Output: ${result.outDir}\nFiles: ${result.files.join(", ")}`,
    };
  } finally {
    store.close();
  }
}

async function switchProviderTool(
  args: Record<string, unknown>,
  runtime: AssistantToolRuntime
): Promise<AssistantToolResult> {
  const role = normalizeProviderRole(stringifyArg(args.role)) ?? undefined;
  const requestedProvider = stringifyArg(args.provider);
  const requestedModel = stringifyArg(args.model);

  let provider: SupportedProvider | null = requestedProvider ? (parseProvider(requestedProvider) ?? null) : null;
  if (!provider && requestedModel) {
    for (const candidate of ["anthropic", "openai", "moonshot"] as SupportedProvider[]) {
      if (resolveModelPreset(candidate, requestedModel)) {
        provider = candidate;
        break;
      }
    }
  }
  if (!provider) {
    provider = resolveProviderConfig(runtime.config.providers, role ?? "simulation").provider;
  }

  const providerEntry = getProviderCatalog(provider);
  if (!process.env[providerEntry.apiKeyEnv]) {
    return {
      status: "error",
      summary: `${providerEntry.label} is not configured in this workspace yet.`,
      details: `Missing ${providerEntry.apiKeyEnv}. Run /model or publicmachina setup.`,
    };
  }

  const model = normalizeModelId(
    provider,
    requestedModel
      ? (resolveModelPreset(provider, requestedModel)?.persistedId
          ?? resolveModelPreset(provider, requestedModel)?.id
          ?? requestedModel)
      : providerEntry.models.find((preset) => preset.tier === "recommended")?.id ?? providerEntry.models[0].id
  );

  const nextConfig = structuredClone(runtime.config);
  nextConfig.providers = role
    ? setRoleProviderSelection(
        nextConfig.providers,
        role,
        createProviderConfig(provider, model, {
          apiKeyEnv: providerEntry.apiKeyEnv,
          ...(providerEntry.baseUrl ? { baseUrl: providerEntry.baseUrl } : {}),
        })
      )
    : setGlobalProviderSelection(nextConfig.providers, provider, model);

  saveConfig(runtime.configPath, nextConfig);
  await runtime.updateConfig(nextConfig);
  return {
    status: "completed",
    summary: role
      ? `Updated ${role} to ${providerEntry.label} / ${describeConfiguredModel(provider, model)}.`
      : `Updated the default provider to ${providerEntry.label} / ${describeConfiguredModel(provider, model)}.`,
  };
}

function resolveDesignedSimulation(
  runtime: AssistantToolRuntime,
  args: Record<string, unknown>
): DesignedSimulationState | null {
  if (runtime.taskState?.activeDesign) return runtime.taskState.activeDesign;
  const configPath = stringifyArg(args.configPath);
  const specPath = stringifyArg(args.specPath);
  if (!configPath || !specPath) return null;
  const config = loadConfig(configPath);
  const rounds = Math.max(
    1,
    Math.round((config.simulation.totalHours * 60) / config.simulation.minutesPerRound)
  );
  return {
    title: "Designed simulation",
    brief: "",
    objective: null,
    hypothesis: null,
    docsPath: stringifyArg(args.docsPath),
    actorCount: readSpecActorCount(specPath),
    specPath,
    configPath,
    historyRecordId: null,
    workspaceDir: dirname(configPath),
    rounds,
  };
}

function resolveRunTarget(
  runtime: AssistantToolRuntime,
  args: Record<string, unknown>
): { dbPath: string; runId: string; historyRecordId: string | null } | null {
  const dbPath = stringifyArg(args.dbPath)
    ?? runtime.taskState?.lastCompletedRun?.dbPath
    ?? runtime.taskState?.lastCancelledRun?.dbPath
    ?? runtime.taskState?.activeRun?.dbPath
    ?? null;
  const runId = stringifyArg(args.runId)
    ?? runtime.taskState?.lastCompletedRun?.runId
    ?? runtime.taskState?.lastCancelledRun?.runId
    ?? runtime.taskState?.activeRun?.runId
    ?? null;
  const historyRecordId = runtime.taskState?.lastCompletedRun?.historyRecordId
    ?? runtime.taskState?.lastCancelledRun?.historyRecordId
    ?? runtime.taskState?.activeRun?.historyRecordId
    ?? runtime.taskState?.activeDesign?.historyRecordId
    ?? null;
  if (!dbPath || !runId) return null;
  return { dbPath, runId, historyRecordId };
}

function stringifyArg(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function materializeSourceDocs(
  workspace: AssistantWorkspaceLayout,
  input: {
    title: string;
    objective: string | null;
    hypothesis: string | null;
    sourceUrls: string[];
    artifactDir: string;
  }
): Promise<{
  docsPath: string;
  referencedUrlCount: number;
  downloadedCount: number;
  warnings: string[];
}> {
  const docsDir = ensureWorkspaceOutputDir(
    workspace,
    "simulations",
    basename(input.artifactDir),
    "docs"
  );
  const warnings: string[] = [];
  const sourceUrls = [...new Set(input.sourceUrls.map((url) => url.trim()).filter(Boolean))];
  const manifest: Array<{ url: string; file?: string; status: "downloaded" | "failed"; error?: string }> = [];
  let downloadedCount = 0;

  for (const [index, url] of sourceUrls.entries()) {
    try {
      const fetched = await fetchSourceDocument(url);
      const baseName = slugify(fetched.title || `source-${index + 1}`) || `source-${index + 1}`;
      const filename = `${String(index + 1).padStart(2, "0")}-${baseName}.md`;
      writeFileSync(join(docsDir, filename), `${fetched.content.trim()}\n`, "utf-8");
      manifest.push({ url, file: filename, status: "downloaded" });
      downloadedCount++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Failed to download ${url}: ${message}`);
      manifest.push({ url, status: "failed", error: message });
    }
  }

  const manifestSections = [
    `# ${input.title}`,
    "",
    "## Objective",
    input.objective ?? "Not specified.",
    "",
    "## Hypothesis",
    input.hypothesis ?? "Not specified.",
    "",
    "## Source Materialization",
    `Referenced URLs: ${sourceUrls.length}`,
    `Downloaded documents: ${downloadedCount}`,
    "",
    "## Source Manifest",
    JSON.stringify(manifest, null, 2),
  ];
  writeFileSync(join(input.artifactDir, "source-manifest.md"), `${manifestSections.join("\n")}\n`, "utf-8");

  return {
    docsPath: docsDir,
    referencedUrlCount: sourceUrls.length,
    downloadedCount,
    warnings,
  };
}

function persistDesignedDocsPath(specPath: string, docsPath: string): void {
  if (!existsSync(specPath)) return;
  try {
    const spec = JSON.parse(readFileSync(specPath, "utf-8")) as { docsPath?: unknown };
    spec.docsPath = docsPath;
    writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`, "utf-8");
  } catch {
    // Ignore malformed specs here; the in-memory task state still carries the correct docsPath.
  }
}

function readSpecActorCount(specPath: string): number | null {
  if (!existsSync(specPath)) return null;
  try {
    const spec = JSON.parse(readFileSync(specPath, "utf-8")) as { actorCount?: unknown };
    if (typeof spec.actorCount !== "number" || !Number.isFinite(spec.actorCount)) {
      return null;
    }
    return Math.max(0, Math.round(spec.actorCount));
  } catch {
    return null;
  }
}

function readSpecFocusActors(specPath: string): string[] {
  if (!existsSync(specPath)) return [];
  try {
    const spec = JSON.parse(readFileSync(specPath, "utf-8")) as { focusActors?: unknown };
    if (!Array.isArray(spec.focusActors)) return [];
    return [...new Set(spec.focusActors.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

function readSpecCastDesign(specPath: string): import("./design.js").CastDesign | undefined {
  if (!existsSync(specPath)) return undefined;
  try {
    const spec = JSON.parse(readFileSync(specPath, "utf-8")) as { castDesign?: unknown };
    if (!spec.castDesign || typeof spec.castDesign !== "object") return undefined;
    return spec.castDesign as import("./design.js").CastDesign;
  } catch {
    return undefined;
  }
}

function persistCastDesign(specPath: string, castDesign: import("./design.js").CastDesign): void {
  if (!existsSync(specPath)) return;
  try {
    const spec = JSON.parse(readFileSync(specPath, "utf-8")) as Record<string, unknown>;
    spec.castDesign = castDesign;
    writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`, "utf-8");
  } catch {
    // Non-fatal: cast design is optional
  }
}

function readSourceDocSummaries(docsPath: string, maxChars = 500): string[] {
  if (!docsPath || !existsSync(docsPath)) return [];
  try {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const files = readdirSync(docsPath)
      .filter((f: string) => f.endsWith(".md") || f.endsWith(".txt"))
      .sort();
    return files.map((file: string) => {
      const content = readFileSync(join(docsPath, file), "utf-8");
      return content.slice(0, maxChars);
    });
  } catch {
    return [];
  }
}

async function fetchSourceDocument(url: string): Promise<{ title: string; content: string }> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "PublicMachina/0.1 (+https://github.com/angelgalvisc/publicmachina)",
      accept: "text/html, text/markdown, text/plain;q=0.9, */*;q=0.5",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const body = await response.text();
  const title = extractDocumentTitle(body, url);
  const content = contentType.includes("text/html")
    ? renderHtmlAsMarkdown(url, title, body)
    : renderTextAsMarkdown(url, title, body);

  if (content.trim().length < 120) {
    throw new Error("Downloaded source content was too short to use as a document.");
  }

  return { title, content };
}

function extractDocumentTitle(body: string, fallbackUrl: string): string {
  const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) {
    return decodeHtmlEntities(titleMatch[1]).replace(/\s+/g, " ").trim();
  }
  return fallbackUrl;
}

function renderTextAsMarkdown(url: string, title: string, text: string): string {
  return [
    `# ${title}`,
    "",
    `Source URL: ${url}`,
    "",
    text.trim(),
  ].join("\n");
}

function renderHtmlAsMarkdown(url: string, title: string, html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const blockNormalized = withoutScripts
    .replace(/<\/(p|div|section|article|header|footer|main|aside|li|ul|ol|h[1-6]|br)>/gi, "\n")
    .replace(/<(p|div|section|article|header|footer|main|aside|li|ul|ol|h[1-6]|br)[^>]*>/gi, "\n");
  const text = decodeHtmlEntities(blockNormalized.replace(/<[^>]+>/g, " "))
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return renderTextAsMarkdown(url, title, text);
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function normalizeProviderRole(value: string | null): ProviderRole | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "analysis" ||
    normalized === "generation" ||
    normalized === "simulation" ||
    normalized === "report" ||
    normalized === "assistant"
  ) {
    return normalized;
  }
  return null;
}

function wouldExceedSessionBudget(runtime: AssistantToolRuntime, additionalCostUsd: number): boolean {
  const budget = runtime.config.assistant.limits.sessionCostBudgetUsd;
  return runtime.taskState.sessionUsage.costUsd + additionalCostUsd > budget;
}

function renderBudgetMessage(runtime: AssistantToolRuntime, additionalCostUsd: number): string {
  const current = runtime.taskState.sessionUsage.costUsd;
  const budget = runtime.config.assistant.limits.sessionCostBudgetUsd;
  const projected = current + additionalCostUsd;
  return `Current session cost: ~$${current.toFixed(2)}. Requested work would add about ~$${additionalCostUsd.toFixed(2)}, exceeding the session cap of ~$${budget.toFixed(2)} (projected: ~$${projected.toFixed(2)}). Use /clear to start a fresh operator session.`;
}
