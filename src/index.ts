#!/usr/bin/env node
/**
 * index.ts — CLI entry point for PublicMachina
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
import { realpathSync } from "node:fs";
import { SQLiteGraphStore, uuid } from "./db.js";
import { loadConfig, defaultConfig, saveConfig } from "./config.js";
import type { SimConfig } from "./config.js";
import { DirectLLMBackend, MockCognitionBackend, getPromptVersion } from "./cognition.js";
import { runSimulation } from "./engine.js";
import { getTierStats } from "./telemetry.js";
import { LLMClient, validateProviderConnection } from "./llm.js";
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
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  type AssistantWorkspaceLayout,
  type AssistantSimulationRecord,
  addDurableMemory,
  appendDailyNote,
  bootstrapAssistantWorkspace,
  listSimulationHistory,
  recordSimulationHistory,
  resolveAssistantWorkspace,
  updateUserProfile,
} from "./assistant-workspace.js";
import { buildAssistantContext } from "./assistant-context.js";
import { appendAssistantMessage, createAssistantSession, resetAssistantSession } from "./assistant-session.js";
import {
  SUPPORTED_PROVIDERS,
  describeConfiguredModel,
  getProviderCatalog,
  getRecommendedModel,
  normalizeModelId,
  parseProvider,
  resolveModelPreset,
  type SupportedProvider,
} from "./model-catalog.js";
import { loadEnvFile, upsertEnvVar } from "./env.js";
import { startAssistantOperator } from "./assistant-operator.js";
import {
  PROVIDER_ROLES,
  createProviderConfig,
  resolveProviderConfig,
  setRoleProviderSelection,
  type ProviderRole,
} from "./provider-selection.js";
import {
  createFeatureLlm,
  createPipelineLlm,
  executePipeline,
  ensureRunManifest,
} from "./simulation-service.js";
import {
  acquireActiveRunLock,
  clearStopRequest,
  createGracefulStopController,
  readStopRequest,
  releaseActiveRunLock,
  stopRequestAppliesToRun,
  writeStopRequest,
} from "./run-control.js";
import { loadAssistantTaskState, setCancellingRunState } from "./assistant-state.js";

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface PromptSession {
  ask: (question: string, defaultValue?: string) => Promise<string>;
  askSecret?: (question: string) => Promise<string>;
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

async function ensureConfigFile(
  configPath: string,
  io: CliIO,
  promptSession?: PromptSession
): Promise<void> {
  if (existsSync(configPath)) return;
  io.stdout(`No config found at ${configPath}. Starting first-run setup.\n\n`);
  await runInitCommand({ output: configPath }, io, promptSession);
}

function createPromptSession(): PromptSession {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return {
    ask: (question, defaultValue) =>
      new Promise<string>((resolve, reject) => {
        let settled = false;
        const suffix = defaultValue ? ` [${defaultValue}]` : "";
        const onClose = () => {
          if (settled) return;
          settled = true;
          reject(new Error("Prompt closed"));
        };
        rl.once("close", onClose);
        rl.question(`${question}${suffix}: `, (answer) => {
          if (settled) return;
          settled = true;
          rl.off("close", onClose);
          const trimmed = answer.trim();
          resolve(trimmed || defaultValue || "");
        });
      }),
    askSecret: (question) =>
      new Promise<string>((resolve, reject) => {
        const stdin = process.stdin;
        const stdout = process.stdout;
        const wasRaw = Boolean((stdin as NodeJS.ReadStream).isRaw);
        let value = "";

        stdout.write(`${question}: `);
        stdin.resume();
        if (stdin.isTTY) stdin.setRawMode?.(true);
        stdin.setEncoding("utf8");

        const onData = (char: string) => {
          if (char === "\u0003") {
            cleanup();
            reject(new Error("Prompt interrupted"));
            return;
          }
          if (char === "\r" || char === "\n") {
            stdout.write("\n");
            cleanup();
            resolve(value.trim());
            return;
          }
          if (char === "\u007f") {
            value = value.slice(0, -1);
            return;
          }
          value += char;
        };

        const cleanup = () => {
          stdin.off("data", onData);
          if (stdin.isTTY) stdin.setRawMode?.(wasRaw);
        };

        stdin.on("data", onData);
      }),
    close: () => rl.close(),
  };
}

interface RunStopMonitor {
  workspace: AssistantWorkspaceLayout | null;
  signal: AbortSignal;
  shouldStop: () => boolean;
  cleanup: () => void;
}

function createRunStopMonitor(
  config: SimConfig,
  io: CliIO,
  options: { configPath?: string; runId: string; source: "run" | "simulate" }
): RunStopMonitor {
  const canUseWorkspace =
    config.assistant.enabled &&
    config.assistant.permissions.readWorkspace &&
    config.assistant.permissions.writeWorkspace;
  const workspace = canUseWorkspace
    ? resolveAssistantWorkspace(config, { configPath: options.configPath })
    : null;

  if (workspace) {
    bootstrapAssistantWorkspace(workspace, config);
    clearStopRequest(workspace);
    if (config.assistant.limits.maxConcurrentRuns <= 1) {
      acquireActiveRunLock(workspace, {
        runId: options.runId,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        source: options.source,
      });
    }
  }

  const controller = createGracefulStopController(io, () => {
    if (!workspace) return;
    writeStopRequest(workspace, {
      requestedAt: new Date().toISOString(),
      source: "signal",
      runId: options.runId,
      reason: "SIGINT",
    });
    const current = loadAssistantTaskState(workspace);
    if (current.activeRun?.runId === options.runId) {
      setCancellingRunState(workspace);
    }
  });

  return {
    workspace,
    signal: controller.signal,
    shouldStop: () => {
      if (!workspace) return controller.signal.aborted;
      return stopRequestAppliesToRun(readStopRequest(workspace), options.runId);
    },
    cleanup: () => {
      if (workspace) {
        clearStopRequest(workspace);
        releaseActiveRunLock(workspace, options.runId);
      }
      controller.cleanup();
    },
  };
}

interface InitAnswers {
  provider: SupportedProvider;
  simulationModel: string;
  reportModel: string;
  apiKeyEnv: string;
  baseUrl?: string;
  apiKeyValue?: string;
  outputDir: string;
  timezone: string;
  workspaceDir: string;
  workspaceReadWrite: boolean;
  rememberConversations: boolean;
  rememberSimulationHistory: boolean;
  searchEnabled: boolean;
  advanced: boolean;
}

const DEFAULT_CONFIG_PATH = "publicmachina.config.yaml";

function askYesNoAnswer(value: string | undefined, defaultValue = true): boolean {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return defaultValue;
  return /^(y|yes|true|1)$/i.test(trimmed);
}

async function askYesNo(
  prompt: PromptSession,
  question: string,
  defaultValue = true
): Promise<boolean> {
  const answer = await prompt.ask(question, defaultValue ? "yes" : "no");
  return askYesNoAnswer(answer, defaultValue);
}

async function askProvider(
  prompt: PromptSession,
  defaultProvider: SupportedProvider
): Promise<SupportedProvider> {
  const options = SUPPORTED_PROVIDERS
    .map((provider, index) => {
      const entry = getProviderCatalog(provider);
      const recommended = provider === defaultProvider ? " (Recommended)" : "";
      return `  ${index + 1}. ${entry.label}${recommended} — ${entry.description}`;
    })
    .join("\n");

  while (true) {
    const answer = await prompt.ask(
      `Choose provider:\n${options}\nEnter name or number`,
      defaultProvider
    );
    const numeric = parseInt(answer, 10);
    if (!Number.isNaN(numeric) && numeric >= 1 && numeric <= SUPPORTED_PROVIDERS.length) {
      return SUPPORTED_PROVIDERS[numeric - 1];
    }
    const parsed = parseProvider(answer);
    if (parsed) return parsed;
  }
}

async function askModel(
  prompt: PromptSession,
  provider: SupportedProvider,
  defaultModelId?: string
): Promise<string> {
  const entry = getProviderCatalog(provider);
  const options = entry.models
    .map((model, index) => {
      const recommended = model.tier === "recommended" ? " (Recommended)" : "";
      const tierLabel =
        model.tier === "best"
          ? "Best quality"
          : model.tier === "fast"
            ? "Fast / lower cost"
            : "Balanced default";
      return `  ${index + 1}. ${model.label}${recommended} — ${tierLabel}`;
    })
    .concat(`  ${entry.models.length + 1}. Custom model ID`)
    .join("\n");

  const defaultDisplay = defaultModelId
    ? describeConfiguredModel(provider, defaultModelId)
    : getRecommendedModel(provider).label;

  while (true) {
    const answer = await prompt.ask(
      `Choose ${entry.label} model:\n${options}\nEnter name or number`,
      defaultDisplay
    );
    const numeric = parseInt(answer, 10);
    if (!Number.isNaN(numeric)) {
      if (numeric >= 1 && numeric <= entry.models.length) {
        return normalizeModelId(provider, entry.models[numeric - 1].id);
      }
      if (numeric === entry.models.length + 1) {
        const custom = await prompt.ask("Custom model ID");
        if (custom.trim()) return custom.trim();
      }
    }

    const preset = resolveModelPreset(provider, answer);
    if (preset) {
      return normalizeModelId(provider, preset.id);
    }
    if (answer.trim()) {
      return answer.trim();
    }
  }
}

function renderReadyBanner(): string {
  return [
    "╔══════════════════════════════════════════════════════╗",
    "║                                                      ║",
    "║   ◉ Wake up!                                         ║",
    "║   PublicMachina ready to forecast.                  ║",
    "║                                                      ║",
    "║   The public sphere is now simulated.               ║",
    "║   Alternate realities are standing by.              ║",
    "║                                                      ║",
    "╚══════════════════════════════════════════════════════╝",
    "",
  ].join("\n");
}

export function buildInteractiveDesignBrief(context: string, request: string): string {
  const normalizedContext = context.trim();
  const normalizedRequest = request.trim();
  if (!normalizedContext) return normalizedRequest;
  return `Context:\n${normalizedContext}\n\nSimulation request:\n${normalizedRequest}`;
}

function canStartAssistantOperator(config: SimConfig): boolean {
  return (
    config.assistant.enabled &&
    config.assistant.permissions.readWorkspace &&
    config.assistant.permissions.writeWorkspace
  );
}

function buildInitConfig(answers: InitAnswers): SimConfig {
  const config = defaultConfig();
  config.simulation.totalHours = 24;
  config.simulation.timezone = answers.timezone;
  config.output.dir = answers.outputDir;
  config.output.format = "markdown";
  config.search.enabled = answers.searchEnabled;
  config.providers.default = createProviderConfig(answers.provider, answers.simulationModel, {
    apiKeyEnv: answers.apiKeyEnv,
    ...(answers.baseUrl ? { baseUrl: answers.baseUrl } : {}),
  });
  config.providers.overrides = {};
  config.assistant.workspaceDir = answers.workspaceDir;
  config.assistant.enabled = answers.workspaceReadWrite;
  config.assistant.permissions.readWorkspace = answers.workspaceReadWrite;
  config.assistant.permissions.writeWorkspace = answers.workspaceReadWrite;
  config.assistant.permissions.rememberConversations = answers.rememberConversations;
  config.assistant.permissions.rememberSimulationHistory = answers.rememberSimulationHistory;

  if (answers.reportModel && answers.reportModel !== answers.simulationModel) {
    config.providers = setRoleProviderSelection(config.providers, "report", {
      provider: answers.provider,
      model: answers.reportModel,
      apiKeyEnv: answers.apiKeyEnv,
      ...(answers.baseUrl ? { baseUrl: answers.baseUrl } : {}),
    });
  }

  return config;
}

export async function runInitCommand(
  opts: { output: string; yes?: boolean; nextStep?: "none" | "design" },
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

  const defaultProvider: SupportedProvider = "anthropic";
  const defaults: InitAnswers = {
    provider: defaultProvider,
    simulationModel: normalizeModelId(defaultProvider, getRecommendedModel(defaultProvider).id),
    reportModel: normalizeModelId(defaultProvider, getRecommendedModel(defaultProvider).id),
    apiKeyEnv: getProviderCatalog(defaultProvider).apiKeyEnv,
    baseUrl: getProviderCatalog(defaultProvider).baseUrl,
    apiKeyValue: undefined,
    outputDir: "./output",
    timezone: defaultConfig().simulation.timezone,
    workspaceDir: defaultConfig().assistant.workspaceDir,
    workspaceReadWrite: true,
    rememberConversations: defaultConfig().assistant.permissions.rememberConversations,
    rememberSimulationHistory: defaultConfig().assistant.permissions.rememberSimulationHistory,
    searchEnabled: false,
    advanced: false,
  };

  let answers: InitAnswers = defaults;
  let prompt = promptSession;
  let createdPrompt = false;
  const nextStep = opts.nextStep ?? "none";
  try {
    if (!opts.yes && (process.stdin.isTTY || promptSession)) {
      if (!prompt) {
        prompt = createPromptSession();
        createdPrompt = true;
      }

      io.stdout("PublicMachina setup\n");
      io.stdout("This wizard configures a real provider first. Mock mode remains available for demos and CI.\n\n");

      const provider = await askProvider(prompt, defaults.provider);
      const providerEntry = getProviderCatalog(provider);
      const providerDefaultModel = normalizeModelId(
        provider,
        provider === defaults.provider
          ? defaults.simulationModel
          : getRecommendedModel(provider).id
      );
      const simulationModel = await askModel(prompt, provider, providerDefaultModel);
      const advanced = await askYesNo(prompt, "Advanced setup (separate report model)?", false);
      const reportModel = advanced
        ? await askModel(prompt, provider, simulationModel)
        : simulationModel;
      const apiKeyValue = (await (prompt.askSecret?.(`Paste your ${providerEntry.label} API key now (leave blank to skip)`)
        ?? prompt.ask(`Paste your ${providerEntry.label} API key now (leave blank to skip)`))).trim();
      const searchEnabled = await askYesNo(
        prompt,
        "Do you want some agents in your simulations to be able to search the internet?",
        defaults.searchEnabled
      );
      const workspaceDir = await prompt.ask(
        "Which folder should I use as your PublicMachina workspace?",
        defaults.workspaceDir
      );
      const workspaceReadWrite = await askYesNo(
        prompt,
        "May I read and write simulation files in that workspace?",
        defaults.workspaceReadWrite
      );
      const rememberConversations = workspaceReadWrite
        ? await askYesNo(
            prompt,
            "Should I remember our conversations in that workspace?",
            defaults.rememberConversations
          )
        : false;
      const rememberSimulationHistory = workspaceReadWrite
        ? await askYesNo(
            prompt,
            "Should I remember previous simulations in that workspace?",
            defaults.rememberSimulationHistory
          )
        : false;

      answers = {
        provider,
        simulationModel,
        reportModel,
        apiKeyEnv: providerEntry.apiKeyEnv,
        baseUrl: providerEntry.baseUrl,
        apiKeyValue: apiKeyValue || undefined,
        outputDir: defaults.outputDir,
        timezone: defaults.timezone,
        workspaceDir,
        workspaceReadWrite,
        rememberConversations,
        rememberSimulationHistory,
        searchEnabled,
        advanced,
      };
    }

    if (answers.apiKeyValue) {
      upsertEnvVar(answers.apiKeyEnv, answers.apiKeyValue);
    }

    const config = buildInitConfig(answers);
    saveConfig(opts.output, config);
    if (config.assistant.enabled) {
      bootstrapAssistantWorkspace(resolveAssistantWorkspace(config, { configPath: opts.output }), config);
    }
    io.stdout(`Created ${opts.output}\n`);

    const envVarExists = Boolean(process.env[answers.apiKeyEnv]);
    let providerReady = envVarExists;
    io.stdout(
      envVarExists
        ? `  [PASS] ${answers.apiKeyEnv} is set\n`
        : `  [WARN] ${answers.apiKeyEnv} is not set yet\n`
    );
    if (answers.searchEnabled) {
      io.stdout(
        `  [INFO] Internet search capability enabled (default endpoint: ${config.search.endpoint})\n`
      );
    }
    if (config.assistant.enabled) {
      io.stdout(
        `  [PASS] Assistant workspace ready at ${config.assistant.workspaceDir}\n`
      );
    } else {
      io.stdout("  [WARN] Assistant workspace memory disabled\n");
    }

    if (envVarExists) {
      try {
        await validateProviderConnection({
          provider: answers.provider,
          sdk: answers.provider,
          model: answers.simulationModel,
          apiKeyEnv: answers.apiKeyEnv,
          baseUrl: answers.baseUrl,
        });
        io.stdout(
          `  [PASS] ${getProviderCatalog(answers.provider).label} validated with ${describeConfiguredModel(answers.provider, answers.simulationModel)}\n`
        );
      } catch (err) {
        providerReady = false;
        io.stderr(`  [WARN] Provider validation failed: ${formatErrorMessage(err)}\n`);
      }
    }

    try {
      const testStore = new SQLiteGraphStore(":memory:");
      testStore.close();
      io.stdout("  [PASS] SQLite open/create check\n");
    } catch (err) {
      io.stderr(`  [FAIL] SQLite check: ${formatErrorMessage(err)}\n`);
    }

    if (
      nextStep === "design" &&
      !opts.yes &&
      prompt &&
      providerReady
    ) {
      io.stdout(`\n${renderReadyBanner()}`);
      if (canStartAssistantOperator(config)) {
        await startAssistantOperator({
          config,
          configPath: opts.output,
          io,
          prompt,
        });
      } else {
        await runDesignCommand(
          {
            config: opts.output,
            outConfig: "publicmachina.generated.config.yaml",
            outSpec: "simulation.spec.json",
          },
          io,
          prompt
        );
      }
      return;
    }

    io.stdout('Next: run "publicmachina doctor" to validate the full setup.\n');
  } finally {
    if (createdPrompt) {
      prompt?.close();
    }
  }
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
  const workspace = config.assistant.enabled
    ? resolveAssistantWorkspace(config, { configPath: opts.config })
    : null;
  if (workspace && config.assistant.permissions.readWorkspace && config.assistant.permissions.writeWorkspace) {
    bootstrapAssistantWorkspace(workspace, config);
  }
  const session = workspace && config.assistant.permissions.rememberConversations
    ? createAssistantSession(workspace, "design")
    : null;

  if (!prompt && interactive) {
    prompt = createPromptSession();
    createdPrompt = true;
  }

  try {
    let brief = opts.brief?.trim() ?? "";
    let preferredName = "there";
    let userContext = "";
    if (!brief) {
      if (!prompt) {
        throw new Error('Natural-language brief required. Pass --brief or run "publicmachina design" interactively.');
      }
      io.stdout("Hello. I'm PublicMachina.\n");
      if (session) appendAssistantMessage(session, "assistant", "Hello. I'm PublicMachina.");
      const ready = await askYesNo(prompt, "Are you ready to simulate?", true);
      if (session) appendAssistantMessage(session, "user", ready ? "Yes, I am ready to simulate." : "No, not yet.");
      if (!ready) {
        io.stdout("Whenever you're ready, run PublicMachina again and we'll start there.\n");
        if (session) {
          appendAssistantMessage(
            session,
            "assistant",
            "Whenever you're ready, run PublicMachina again and we'll start there."
          );
        }
        return;
      }
      preferredName = (await prompt.ask("What should I call you?", "there")).trim() || "there";
      if (session) appendAssistantMessage(session, "user", `Call me ${preferredName}.`);
      io.stdout(`Good to meet you, ${preferredName}.\n`);
      if (session) appendAssistantMessage(session, "assistant", `Good to meet you, ${preferredName}.`);
      if (workspace) {
        updateUserProfile(workspace, { preferredName });
      }
      const context = await prompt.ask(
        "What context should I keep in mind? You can mention the domain, region, organization, or objective.",
        ""
      );
      userContext = context.trim();
      if (session && userContext) {
        appendAssistantMessage(session, "user", `Context: ${userContext}`);
      }
      const request = await prompt.ask(`What would you like to simulate today, ${preferredName}?`);
      if (session) appendAssistantMessage(session, "user", request);
      if (workspace) {
        updateUserProfile(workspace, {
          lastContext: userContext || null,
          ...(userContext ? { addNote: userContext } : {}),
        });
      }
      const assistantContext = workspace
        ? buildAssistantContext(workspace, config, `${context}\n${request}`)
        : null;
      brief = buildInteractiveDesignBrief(
        [
          assistantContext?.summary ? `Operator workspace context:\n${assistantContext.summary}` : "",
          context.trim(),
        ]
          .filter(Boolean)
          .join("\n\n"),
        request
      );
    }

    const llm = createFeatureLlm(config, { mock: opts.mock, feature: "design" });
    const result = await designSimulationFromBrief(llm, brief, {
      docsPath: opts.docs,
      baseConfig: config,
    });

    io.stdout(result.preview);
    if (session) appendAssistantMessage(session, "assistant", result.preview);

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
      if (!askYesNoAnswer(overwrite, false)) {
        io.stdout("Aborted before writing output files.\n");
        return;
      }
    }

    if (!opts.yes) {
      if (!prompt) {
        throw new Error("Design confirmation requires interactive mode or --yes.");
      }
      const confirm = await prompt.ask("Write the generated spec and config? (yes/no)", "yes");
      if (!askYesNoAnswer(confirm, true)) {
        io.stdout("Aborted before writing output files.\n");
        return;
      }
    }

    writeFileSync(opts.outSpec, `${JSON.stringify(result.spec, null, 2)}\n`, "utf-8");
    writeFileSync(opts.outConfig, result.yaml, "utf-8");

    io.stdout(`Wrote ${opts.outSpec}\n`);
    io.stdout(`Wrote ${opts.outConfig}\n`);
    if (session) {
      appendAssistantMessage(
        session,
        "assistant",
        `I wrote ${opts.outSpec} and ${opts.outConfig} for ${result.spec.title}.`
      );
    }

    if (workspace) {
      const contextSummary = userContext || null;
      recordSimulationHistory(workspace, {
        title: result.spec.title,
        objective: result.spec.objective,
        hypothesis: result.spec.hypothesis,
        brief,
        context: contextSummary,
        specPath: opts.outSpec,
        configPath: opts.outConfig,
        docsPath: result.spec.docsPath,
        tags: result.spec.focusActors,
      });
      appendDailyNote(workspace, {
        title: `Simulation design — ${result.spec.title}`,
        lines: [
          `User: ${preferredName === "there" ? "unknown" : preferredName}`,
          `Objective: ${result.spec.objective}`,
          `Hypothesis: ${result.spec.hypothesis ?? "not provided"}`,
          `Focus actors: ${result.spec.focusActors.join(", ") || "none"}`,
        ],
      });
      addDurableMemory(workspace, {
        kind: "simulation",
        summary: `Designed simulation "${result.spec.title}" with objective: ${result.spec.objective}`,
        tags: result.spec.focusActors,
      });
    }

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
  const stopMonitor = createRunStopMonitor(config, io, {
    configPath: opts.config,
    runId,
    source: "simulate",
  });

  try {
    const result = await runSimulation({
      store,
      config,
      backend,
      runId,
      signal: stopMonitor.signal,
      shouldStop: stopMonitor.shouldStop,
    });

    io.stdout(`Simulation ${result.status}\n`);
    io.stdout(`  Run ID: ${result.runId}\n`);
    io.stdout(
      result.status === "cancelled"
        ? `  Completed rounds: ${result.completedRounds}/${result.totalRounds}\n`
        : `  Rounds: ${result.totalRounds}\n`
    );
    io.stdout(`  Wall time: ${(result.wallTimeMs / 1000).toFixed(1)}s\n`);
  } finally {
    stopMonitor.cleanup();
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

  const runId = opts.run ?? uuid();
  const stopMonitor = createRunStopMonitor(config, io, {
    configPath: opts.config,
    runId,
    source: "run",
  });
  let result!: Awaited<ReturnType<typeof executePipeline>>;
  try {
    result = await executePipeline({
      config,
      dbPath: opts.db,
      docsPath: opts.docs,
      runId,
      hypothesis: opts.hypothesis,
      mock: opts.mock,
      signal: stopMonitor.signal,
      shouldStop: stopMonitor.shouldStop,
    });
  } finally {
    stopMonitor.cleanup();
  }

  io.stdout(`Ingested documents from ${opts.docs}\n`);
  io.stdout(`Generated ${result.actorsCreated} actors for run ${runId}\n`);

  if (opts.config && config.assistant.enabled) {
    const workspace = resolveAssistantWorkspace(config, { configPath: opts.config });
    bootstrapAssistantWorkspace(workspace, config);
    recordSimulationHistory(workspace, {
      title: opts.hypothesis ? `Run ${runId}: ${opts.hypothesis}` : `Run ${runId}`,
      objective: opts.hypothesis ?? "Pipeline run",
      hypothesis: opts.hypothesis ?? null,
      brief: opts.hypothesis ?? `Pipeline run ${runId}`,
      docsPath: opts.docs,
      configPath: opts.config,
      dbPath: opts.db,
      runId,
    });
  }

  io.stdout(`Pipeline ${result.status}\n`);
  io.stdout(`  Run ID: ${result.runId}\n`);
  io.stdout(
    result.status === "cancelled"
      ? `  Completed rounds: ${result.completedRounds}/${result.totalRounds}\n`
      : `  Rounds: ${result.totalRounds}\n`
  );
  io.stdout(`  Graph revision: ${result.graphRevisionId}\n`);
}

function runStopCommand(
  opts: { config?: string; run?: string },
  io: CliIO
): void {
  const configPath = opts.config ?? DEFAULT_CONFIG_PATH;
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const config = getConfig(configPath);
  if (
    !config.assistant.enabled ||
    !config.assistant.permissions.readWorkspace ||
    !config.assistant.permissions.writeWorkspace
  ) {
    throw new Error(
      "Graceful stop requires an enabled assistant workspace with read/write permissions."
    );
  }

  const workspace = resolveAssistantWorkspace(config, { configPath });
  bootstrapAssistantWorkspace(workspace, config);
  const taskState = loadAssistantTaskState(workspace);
  const activeRun = taskState.activeRun;
  const targetRunId = opts.run ?? activeRun?.runId ?? null;

  if (!targetRunId) {
    io.stdout("No active simulation run is recorded in the workspace. Pass --run <id> to target a specific run.\n");
    return;
  }

  if (opts.run && activeRun && opts.run !== activeRun.runId) {
    throw new Error(`The active run is ${activeRun.runId}, not ${opts.run}.`);
  }

  writeStopRequest(workspace, {
    requestedAt: new Date().toISOString(),
    source: "command",
    runId: targetRunId,
    reason: "Requested from publicmachina stop.",
  });
  if (activeRun?.runId === targetRunId) {
    setCancellingRunState(workspace);
  }
  io.stdout(
    `Graceful stop requested for run ${targetRunId}. PublicMachina will stop after the current safe checkpoint.\n`
  );
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
  io.stdout(`        ${B}${C}P U B L I C M A C H I N A${R}  ${D}v0.1.0${R}\n`);
  io.stdout(`   ${D}public narrative simulation · web-grounded cognition${R}\n`);
  io.stdout("\n");
}

function formatHistoryRecord(record: AssistantSimulationRecord): string {
  return [
    `${record.title}`,
    `  Created: ${record.createdAt}`,
    `  Objective: ${record.objective ?? "not captured"}`,
    `  Hypothesis: ${record.hypothesis ?? "not captured"}`,
    `  Workspace: ${record.workspaceDir}`,
  ].join("\n");
}

export function createProgram(io: CliIO = defaultIO): Command {
  const program = new Command()
    .name("publicmachina")
    .version("0.1.0")
    .description("Auditable social simulation engine for public narratives")
    .configureOutput({
      writeOut: (text) => io.stdout(text),
      writeErr: (text) => io.stderr(text),
    })
    .hook("preAction", () => {
      printBanner(io);
    });

  program.action(async () => {
    if (!process.stdin.isTTY) {
      program.outputHelp();
      return;
    }

    const prompt = createPromptSession();
    try {
      await ensureConfigFile(DEFAULT_CONFIG_PATH, io, prompt);
      const config = getConfig(DEFAULT_CONFIG_PATH);
      if (canStartAssistantOperator(config)) {
        await startAssistantOperator({
          config,
          configPath: DEFAULT_CONFIG_PATH,
          io,
          prompt,
        });
      } else {
        await runDesignCommand(
          {
            config: DEFAULT_CONFIG_PATH,
            outConfig: "publicmachina.generated.config.yaml",
            outSpec: "simulation.spec.json",
          },
          io,
          prompt
        );
      }
    } finally {
      prompt.close();
    }
  });

  program
    .command("assistant")
    .description("Start the PublicMachina conversational operator")
    .option("--config <path>", "config YAML file", DEFAULT_CONFIG_PATH)
    .option("--mock", "use mock planner + mock pipeline services")
    .action(async (opts) => {
      await ensureConfigFile(opts.config, io);
      const prompt = createPromptSession();
      try {
        const config = getConfig(opts.config);
        if (!canStartAssistantOperator(config)) {
          throw new Error(
            "The conversational operator requires an enabled workspace with read/write permissions. Re-run `publicmachina setup`."
          );
        }
        await startAssistantOperator({
          config,
          configPath: opts.config,
          io,
          prompt,
          mock: opts.mock,
        });
      } finally {
        prompt.close();
      }
    });

  program
    .command("stop")
    .description("Request a graceful stop for the active simulation run")
    .option("--config <path>", "config YAML file", DEFAULT_CONFIG_PATH)
    .option("--run <id>", "explicit run ID to stop")
    .action((opts) => {
      runStopCommand(opts, io);
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
    .option("--out-config <path>", "generated config output path", "publicmachina.generated.config.yaml")
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
    .option("--config <path>", "config YAML file")
    .option("--question <text>", "single question (omit for REPL mode)")
    .option("--mock", "use MockCognitionBackend")
    .action(async (opts) => {
      const store = new SQLiteGraphStore(opts.db);
      try {
        const runId = opts.run ?? store.getLatestRunId();
        if (!runId) throw new Error("No runs found in database.");

        const actor = resolveActorByName(store, runId, opts.actor);
        const config = getConfig(opts.config);
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
        io.stdout(`  Memories: ${result.memoriesExported}\n`);
        io.stdout(`  Posts: ${result.postsExported}\n`);
        io.stdout(`  Exposures: ${result.exposuresExported}\n`);
        io.stdout(`  Decisions: ${result.decisionsExported}\n`);
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
        io.stdout(
          `  Topics: ${result.topicsImported}, Beliefs: ${result.beliefsImported}, Memories: ${result.memoriesImported}, Posts: ${result.postsImported}, Exposures: ${result.exposuresImported}, Decisions: ${result.decisionsImported}\n`
        );
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
        const llm = createFeatureLlm(config, { mock: opts.mock, feature: "report" });
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

  program
    .command("history")
    .description("Show previous assistant-tracked simulations from the workspace")
    .option("--config <path>", "config YAML file", DEFAULT_CONFIG_PATH)
    .option("--query <text>", "filter simulations by keyword")
    .option("--json", "output raw JSON")
    .action((opts) => {
      const config = getConfig(opts.config);
      if (!config.assistant.enabled) {
        io.stdout("Assistant workspace memory is disabled in this config.\n");
        return;
      }
      const workspace = resolveAssistantWorkspace(config, { configPath: opts.config });
      bootstrapAssistantWorkspace(workspace, config);
      const history = listSimulationHistory(workspace, { query: opts.query, limit: 20 });
      if (opts.json) {
        io.stdout(`${JSON.stringify(history, null, 2)}\n`);
        return;
      }
      if (history.length === 0) {
        io.stdout("No previous simulations found in this workspace.\n");
        return;
      }
      for (const record of history) {
        io.stdout(`${formatHistoryRecord(record)}\n\n`);
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
    .option("--config <path>", "config YAML file", DEFAULT_CONFIG_PATH)
    .option("--mock", "use mock cognition + mock NL query translation")
    .action(async (opts) => {
      if (!opts.mock) {
        await ensureConfigFile(opts.config, io);
      }

      const store = new SQLiteGraphStore(opts.db);
      try {
        const runId = opts.run ?? store.getLatestRunId();
        if (!runId) throw new Error("No runs found in database.");

        const config = opts.mock && !existsSync(opts.config)
          ? defaultConfig()
          : getConfig(opts.config);
        const workspace = config.assistant.enabled
          ? resolveAssistantWorkspace(config, { configPath: opts.config })
          : null;
        if (workspace && config.assistant.permissions.readWorkspace && config.assistant.permissions.writeWorkspace) {
          bootstrapAssistantWorkspace(workspace, config);
        }
        const shellCtx: Parameters<typeof startShell>[0] = {
          store,
          runId,
          config,
          configPath: opts.config,
        };
        if (workspace && config.assistant.permissions.rememberConversations) {
          shellCtx.assistantSession = createAssistantSession(workspace, "shell");
          shellCtx.onAssistantClear = async () => resetAssistantSession(workspace, "shell");
        }
        shellCtx.llm = createFeatureLlm(config, { mock: opts.mock, feature: "shell" });
        shellCtx.backend = opts.mock
          ? new MockCognitionBackend()
          : new DirectLLMBackend(
              shellCtx.llm,
              store,
              { runId, promptVersion: getPromptVersion() }
            );

        if (shellCtx.backend) await shellCtx.backend.start();

        shellCtx.onConfigUpdate = async (nextConfig) => {
          if (shellCtx.backend) await shellCtx.backend.shutdown();
          shellCtx.config = nextConfig;
          shellCtx.llm = createFeatureLlm(nextConfig, { mock: opts.mock, feature: "shell" });
          shellCtx.backend = opts.mock
            ? new MockCognitionBackend()
            : new DirectLLMBackend(
                shellCtx.llm,
                store,
                { runId, promptVersion: getPromptVersion() }
              );
          if (shellCtx.backend) await shellCtx.backend.start();
        };

        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        try {
          await startShell(
            shellCtx,
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
          if (shellCtx.backend) await shellCtx.backend.shutdown();
        }
      } finally {
        store.close();
      }
    });

  // ═══════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════

  program
    .command("setup")
    .alias("init")
    .description("Guided first-run provider and model setup")
    .option("--output <path>", "config file output path", "publicmachina.config.yaml")
    .option("--yes", "write defaults without interactive prompts")
    .action(async (opts) => {
      await runInitCommand({ ...opts, nextStep: "design" }, io);
    });

  // ═══════════════════════════════════════════════════════
  // DOCTOR
  // ═══════════════════════════════════════════════════════

  program
    .command("doctor")
    .description("Run diagnostic checks")
    .option("--config <path>", "config file path", "publicmachina.config.yaml")
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
          for (const role of PROVIDER_ROLES) {
            const provider = resolveProviderConfig(config.providers, role);
            const envVar = provider.apiKeyEnv;
            if (process.env[envVar]) {
              io.stdout(`  [PASS] ${role}: ${envVar} is set\n`);
              passed++;
            } else {
              io.stdout(`  [FAIL] ${role}: ${envVar} not set\n`);
              failed++;
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

          if (config.assistant.enabled) {
            try {
              const workspace = resolveAssistantWorkspace(config, { configPath: opts.config });
              bootstrapAssistantWorkspace(workspace, config);
              io.stdout(`  [PASS] assistant: workspace ready at ${workspace.rootDir}\n`);
              passed++;
            } catch (err) {
              io.stdout(
                `  [FAIL] assistant: workspace bootstrap failed (${formatErrorMessage(err)})\n`
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
        io.stdout(`         Run "publicmachina setup" to create one, or pass --config <path>.\n`);
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
        io.stdout(`"publicmachina ${stub.name}" is not yet implemented.\n`);
      });
  }

  return program;
}

export async function runCli(argv = process.argv, io: CliIO = defaultIO): Promise<void> {
  loadEnvFile();
  const program = createProgram(io);
  await program.parseAsync(argv);
}

const entryHref = process.argv[1]
  ? pathToFileURL(realpathSync(process.argv[1])).href
  : null;

if (entryHref && import.meta.url === entryHref) {
  runCli().catch((err) => {
    defaultIO.stderr(`${formatErrorMessage(err)}\n`);
    process.exitCode = 1;
  });
}
