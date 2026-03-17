/**
 * assistant-operator.ts — Hybrid conversational operator for PublicMachina.
 */

import type { SimConfig } from "./config.js";
import {
  addDurableMemory,
  appendDailyNote,
  bootstrapAssistantWorkspace,
  loadUserProfile,
  resolveAssistantWorkspace,
  updateUserProfile,
  type AssistantWorkspaceLayout,
} from "./assistant-workspace.js";
import { buildAssistantContext } from "./assistant-context.js";
import {
  appendAssistantMessage,
  appendAssistantTrace,
  createAssistantSession,
  resetAssistantSession,
  type AssistantSession,
} from "./assistant-session.js";
import {
  addSessionUsage,
  loadAssistantTaskState,
  resetConversationState,
  setDesignedSimulationState,
  type AssistantTaskState,
} from "./assistant-state.js";
import { planAssistantStep } from "./assistant-planner.js";
import {
  executeAssistantTool,
  getAvailableAssistantTools,
  type AssistantToolRuntime,
} from "./assistant-tools.js";
import { createFeatureLlm } from "./simulation-service.js";
import { handleModelCommand } from "./model-command.js";

export interface AssistantOperatorIO {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Dim system-level status messages (progress, meta-info). */
  status?(text: string): void;
}

export interface AssistantPromptSession {
  ask: (question: string, defaultValue?: string, options?: { multiline?: boolean }) => Promise<string>;
}

export interface StartAssistantOperatorOptions {
  config: SimConfig;
  configPath: string;
  io: AssistantOperatorIO;
  prompt: AssistantPromptSession;
  mock?: boolean;
}

export async function startAssistantOperator(
  options: StartAssistantOperatorOptions
): Promise<void> {
  const { io, prompt } = options;
  let config = options.config;
  const workspace = requireWorkspace(config, options.configPath);
  bootstrapAssistantWorkspace(workspace, config);

  let session = config.assistant.permissions.rememberConversations
    ? createAssistantSession(workspace, "design")
    : undefined;
  let taskState = loadAssistantTaskState(workspace);
  let plannerLlm = createFeatureLlm(config, { mock: options.mock, feature: "assistant" });
  const userProfile = loadUserProfile(workspace);
  let preferredName = userProfile.preferredName ?? "there";
  const conversation: Array<{ role: "user" | "assistant"; content: string }> = [];

  const updateConfig = async (nextConfig: SimConfig): Promise<void> => {
    config = nextConfig;
    plannerLlm = createFeatureLlm(nextConfig, { mock: options.mock, feature: "assistant" });
  };

  const updateTaskState = (nextState: AssistantTaskState): void => {
    recordAssistantTrace(session, "task_state", {
      fromStatus: taskState.status,
      toStatus: nextState.status,
      activeDesignTitle: nextState.activeDesign?.title ?? null,
      activeRunId: nextState.activeRun?.runId ?? null,
      pendingRunId: nextState.pendingRun?.runId ?? null,
    });
    taskState = nextState;
  };

  const runtime: AssistantToolRuntime = {
    get config() {
      return config;
    },
    configPath: options.configPath,
    workspace,
    get taskState() {
      return taskState;
    },
    mock: options.mock,
    updateConfig,
    updateTaskState,
    onProgress: (message) => {
      (io.status ?? io.stdout)(`${message}\n`);
      recordAssistantMessage(session, conversation, "assistant", message);
    },
  };

  io.stdout("Hello. I'm PublicMachina.\n");
  recordAssistantMessage(session, conversation, "assistant", "Hello. I'm PublicMachina.");

  if (taskState.status === "awaiting_confirmation" && taskState.pendingRun && taskState.activeDesign) {
    const pendingMessage = `I still have "${taskState.activeDesign.title}" ready to run. Reply yes to launch it, or no to keep the design without running.`;
    io.stdout(`${pendingMessage}\n`);
    recordAssistantMessage(session, conversation, "assistant", pendingMessage);
  } else if (taskState.status === "running" && taskState.activeRun) {
    const runningMessage = `A simulation is currently running: ${taskState.activeRun.runId} (${taskState.activeRun.roundsCompleted}/${taskState.activeRun.totalRounds} rounds completed). You can say "stop it" or use /stop from another operator session.`;
    io.stdout(`${runningMessage}\n`);
    recordAssistantMessage(session, conversation, "assistant", runningMessage);
  } else if (taskState.status === "cancelling" && taskState.activeRun) {
    const stoppingMessage = `A graceful stop has already been requested for ${taskState.activeRun.runId}.`;
    io.stdout(`${stoppingMessage}\n`);
    recordAssistantMessage(session, conversation, "assistant", stoppingMessage);
  } else if (taskState.lastCancelledRun) {
    const cancelledMessage = `The last run I remember was stopped cleanly: ${taskState.lastCancelledRun.runId} after ${taskState.lastCancelledRun.roundsCompleted}/${taskState.lastCancelledRun.totalRounds} rounds.`;
    io.stdout(`${cancelledMessage}\n`);
    recordAssistantMessage(session, conversation, "assistant", cancelledMessage);
  } else if (taskState.lastCompletedRun) {
    const statusMessage = `The latest completed run I remember is ${taskState.lastCompletedRun.runId} for "${taskState.lastCompletedRun.title}".`;
    io.stdout(`${statusMessage}\n`);
    recordAssistantMessage(session, conversation, "assistant", statusMessage);
  } else if (taskState.lastFailure) {
    const failureMessage = `The last run failed: ${taskState.lastFailure.message}`;
    io.stdout(`${failureMessage}\n`);
    recordAssistantMessage(session, conversation, "assistant", failureMessage);
  }

  const ready = await askYesNo(prompt, "Are you ready to simulate?", true);
  recordAssistantMessage(
    session,
    conversation,
    "user",
    ready ? "Yes, I am ready to simulate." : "No, not yet."
  );
  if (!ready) {
    const farewell = "Whenever you're ready, run PublicMachina again and we'll start there.";
    io.stdout(`${farewell}\n`);
    recordAssistantMessage(session, conversation, "assistant", farewell);
    return;
  }

  if (userProfile.preferredName) {
    const returning = `Welcome back, ${userProfile.preferredName}.`;
    io.stdout(`${returning}\n`);
    recordAssistantMessage(session, conversation, "assistant", returning);
  } else {
    const preferred = await prompt.ask("What should I call you?", "there");
    preferredName = preferred.trim() || "there";
    updateUserProfile(workspace, { preferredName });
    recordAssistantMessage(session, conversation, "user", `Call me ${preferredName}.`);
    const greet = `Good to meet you, ${preferredName}.`;
    io.stdout(`${greet}\n`);
    recordAssistantMessage(session, conversation, "assistant", greet);
  }

  let context = "";
  if (userProfile.lastContext) {
    context = userProfile.lastContext;
    const rememberedContext = `I will keep using your last context unless you tell me to change it: ${context}`;
    (io.status ?? io.stdout)(`${rememberedContext}\n`);
    recordAssistantMessage(session, conversation, "assistant", rememberedContext);
  } else {
    context = await prompt.ask(
      "What context should I keep in mind? You can mention the domain, region, organization, or objective.",
      ""
    );
  }

  if (context.trim()) {
    updateUserProfile(workspace, {
      lastContext: context.trim(),
      addNote: context.trim(),
    });
    addDurableMemory(workspace, {
      kind: "context",
      summary: `Operator context for this session: ${context.trim()}`,
      tags: [],
    });
    appendDailyNote(workspace, {
      title: "Operator session context",
      lines: [context.trim()],
    });
    recordAssistantMessage(session, conversation, "user", `Context: ${context.trim()}`);
  }

  const openingQuestion = `What would you like to work on today, ${preferredName}? You can ask me to design, run, inspect, report on, or compare simulations.`;
  io.stdout(`${openingQuestion}\n`);
  recordAssistantMessage(session, conversation, "assistant", openingQuestion);
  let nextInput = await prompt.ask(`[${preferredName}]`, "", { multiline: true });

  while (true) {
    const input = nextInput.trim();
    nextInput = "";
    if (!input) {
      nextInput = await prompt.ask(`[${preferredName}]`, "", { multiline: true });
      continue;
    }

    if (await handleOperatorSlashCommand(input, {
      io,
      getSession: () => session,
      conversation,
      runtime,
      onSessionReset: async () => {
        taskState = resetConversationState(workspace);
        session = resetAssistantSession(workspace, "design");
      },
    })) {
      if (/^(\/exit|quit|exit)$/i.test(input)) {
        return;
      }
      nextInput = await prompt.ask(`[${preferredName}]`, "", { multiline: true });
      continue;
    }

    recordAssistantMessage(session, conversation, "user", input);
    recordAssistantTrace(session, "input_received", {
      length: input.length,
      lineCount: input.split(/\r?\n/).length,
      containsUrl: /https?:\/\//i.test(input),
      structuredLabelsDetected:
        /(^|\n)\s*(t[ií]tulo|title|objetivo|objective|evento inicial|initial event|actores clave|key actors|configuraci[oó]n|configuration|fecha focal|focal date|fuente principal|primary source)\s*:/i.test(
          input
        ),
      taskStatus: taskState.status,
    });

    if (taskState.status === "awaiting_confirmation" && taskState.pendingRun) {
      const normalized = input.toLowerCase();
      if (/^(y|yes|run|confirm)$/i.test(normalized)) {
        const pending = taskState.pendingRun;
        const result = await executeAssistantTool(
          "run_simulation",
          {
            specPath: pending.specPath,
            configPath: pending.configPath,
            docsPath: pending.docsPath,
            confirmed: true,
          },
          runtime
        );
        emitToolResult(io, session, conversation, result);
        nextInput = await prompt.ask(`[${preferredName}]`, "", { multiline: true });
        continue;
      }
      if (/^(n|no|cancel)$/i.test(normalized)) {
        taskState = setDesignedSimulationState(workspace, taskState.activeDesign!);
        const message = "Understood. I kept the design and cleared the pending run confirmation.";
        io.stdout(`${message}\n`);
        recordAssistantMessage(session, conversation, "assistant", message);
        nextInput = await prompt.ask(`[${preferredName}]`, "", { multiline: true });
        continue;
      }
    }

    const assistantContext = buildAssistantContext(workspace, config, input);
    const toolTrace: string[] = [];
    let responded = false;

    for (let step = 0; step < 4; step += 1) {
      let decision;
      try {
        decision = await planAssistantStep(plannerLlm, {
          contextSummary: assistantContext.summary,
          currentTaskSummary: summarizeTaskState(taskState),
          conversation,
          userInput: input,
          tools: getAvailableAssistantTools(taskState),
          toolTrace,
        });
      } catch (err) {
        const message = `I hit a planner error and kept the session alive. Please try again in simpler words. (${err instanceof Error ? err.message : String(err)})`;
        io.stderr(`${message}\n`);
        recordAssistantMessage(session, conversation, "assistant", message);
        responded = true;
        break;
      }
      recordAssistantTrace(session, "planner_decision", {
        kind: decision.kind,
        tool: decision.kind === "tool_call" ? decision.tool : null,
        model: decision.meta.model,
        costUsd: decision.meta.costUsd,
        inputTokens: decision.meta.inputTokens,
        outputTokens: decision.meta.outputTokens,
      });

      if (decision.kind === "respond") {
        runtime.updateTaskState(addSessionUsage(workspace, {
          costUsd: decision.meta.costUsd,
        }));
        io.stdout(`${decision.message}\n`);
        recordAssistantMessage(session, conversation, "assistant", decision.message);
        responded = true;
        break;
      }

      runtime.updateTaskState(addSessionUsage(workspace, {
        costUsd: decision.meta.costUsd,
        toolCalls: 1,
      }));
      recordAssistantTrace(session, "tool_call", {
        tool: decision.tool,
        args: summarizeToolArguments(decision.tool, decision.arguments),
      });
      const result = await executeAssistantTool(decision.tool, decision.arguments, runtime);
      recordAssistantTrace(session, "tool_result", {
        tool: decision.tool,
        status: result.status,
        summary: result.summary,
      });
      if (result.status === "needs_confirmation") {
        emitToolResult(io, session, conversation, result);
        responded = true;
        break;
      }
      if (result.status === "error") {
        emitToolResult(io, session, conversation, result);
        responded = true;
        break;
      }

      toolTrace.push(`TOOL ${decision.tool}: ${result.summary}${result.details ? `\n${result.details}` : ""}`);
      emitToolResult(io, session, conversation, result);
      responded = true;
      break;
    }

    if (!responded) {
      const fallback = "I have the work staged. Tell me whether to keep refining it, run it, or inspect something from history.";
      io.stdout(`${fallback}\n`);
      recordAssistantMessage(session, conversation, "assistant", fallback);
    }

    nextInput = await prompt.ask(`[${preferredName}]`, "", { multiline: true });
  }
}

function requireWorkspace(config: SimConfig, configPath: string): AssistantWorkspaceLayout {
  if (!config.assistant.enabled || !config.assistant.permissions.readWorkspace || !config.assistant.permissions.writeWorkspace) {
    throw new Error(
      "The operator assistant requires an enabled workspace with read/write permissions. Re-run `publicmachina setup` and allow workspace access."
    );
  }
  return resolveAssistantWorkspace(config, { configPath });
}

function summarizeTaskState(taskState: AssistantTaskState): string {
  const lines = [`- Status: ${taskState.status}`];
  lines.push(`- Session spend: ~$${taskState.sessionUsage.costUsd.toFixed(2)} across ${taskState.sessionUsage.toolCalls} tool calls`);
  if (taskState.activeDesign) {
    lines.push(`- Active design: ${taskState.activeDesign.title}`);
    lines.push(`- Spec: ${taskState.activeDesign.specPath}`);
    lines.push(`- Config: ${taskState.activeDesign.configPath}`);
  }
  if (taskState.pendingRun) {
    lines.push(`- Pending run: ${taskState.pendingRun.runId} (${taskState.pendingRun.estimate.rounds} rounds)`);
  }
  if (taskState.lastCompletedRun) {
    lines.push(`- Last completed run: ${taskState.lastCompletedRun.runId} (${taskState.lastCompletedRun.title})`);
  }
  if (taskState.lastCancelledRun) {
    lines.push(`- Last cancelled run: ${taskState.lastCancelledRun.runId} (${taskState.lastCancelledRun.roundsCompleted}/${taskState.lastCancelledRun.totalRounds} rounds)`);
  }
  if (taskState.lastFailure) {
    lines.push(`- Last failure: ${taskState.lastFailure.message}`);
  }
  return lines.join("\n");
}

function recordAssistantMessage(
  session: AssistantSession | undefined,
  conversation: Array<{ role: "user" | "assistant"; content: string }>,
  role: "user" | "assistant",
  content: string
): void {
  conversation.push({ role, content });
  if (session) {
    appendAssistantMessage(session, role, content);
  }
}

function recordAssistantTrace(
  session: AssistantSession | undefined,
  name: string,
  data: Record<string, unknown>
): void {
  if (session) {
    appendAssistantTrace(session, name, data);
  }
}

function summarizeToolArguments(
  tool: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  if (tool === "design_simulation") {
    const brief = typeof args.brief === "string" ? args.brief : "";
    return {
      docsPath: typeof args.docsPath === "string" ? args.docsPath : null,
      briefLength: brief.length,
      briefPreview: brief.length > 180 ? `${brief.slice(0, 180)}...` : brief,
    };
  }

  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => {
      if (typeof value === "string") {
        return [key, value.length > 180 ? `${value.slice(0, 180)}...` : value];
      }
      return [key, value];
    })
  );
}

function emitToolResult(
  io: AssistantOperatorIO,
  session: AssistantSession | undefined,
  conversation: Array<{ role: "user" | "assistant"; content: string }>,
  result: { summary: string; details?: string }
): void {
  const message = result.details ? `${result.summary}\n${result.details}` : result.summary;
  io.stdout(`${message}\n`);
  recordAssistantMessage(session, conversation, "assistant", message);
}

async function askYesNo(prompt: AssistantPromptSession, question: string, defaultValue = true): Promise<boolean> {
  const answer = await prompt.ask(question, defaultValue ? "yes" : "no");
  const trimmed = answer.trim().toLowerCase();
  if (!trimmed) return defaultValue;
  return /^(y|yes|true|1)$/i.test(trimmed);
}

async function handleOperatorSlashCommand(
  input: string,
  context: {
    io: AssistantOperatorIO;
    getSession: () => AssistantSession | undefined;
    conversation: Array<{ role: "user" | "assistant"; content: string }>;
    runtime: AssistantToolRuntime;
    onSessionReset: () => Promise<void>;
  }
): Promise<boolean> {
  if (!input.startsWith("/")) return false;

  if (/^\/help$/i.test(input)) {
    const help = [
      "Slash commands:",
      "  /help   Show assistant help",
      "  /model  Show or change the current provider/model",
      "  /stop   Request a graceful stop for the active simulation run",
      "  /clear  Start a fresh conversation without deleting durable memory",
      "  /exit   Leave the operator",
    ].join("\n");
    context.io.stdout(`${help}\n`);
    recordAssistantMessage(context.getSession(), context.conversation, "assistant", help);
    return true;
  }

  if (/^\/clear$/i.test(input)) {
    await context.onSessionReset();
    const message = "Started a fresh operator conversation. Durable memory and simulation history were kept.";
    (context.io.status ?? context.io.stdout)(`${message}\n`);
    recordAssistantMessage(context.getSession(), context.conversation, "assistant", message);
    context.conversation.length = 0;
    return true;
  }

  if (/^\/stop$/i.test(input)) {
    const result = await executeAssistantTool("stop_simulation", {}, context.runtime);
    emitToolResult(context.io, context.getSession(), context.conversation, result);
    return true;
  }

  if (/^\/model(?:\s+.*)?$/i.test(input)) {
    const args = input.replace(/^\/model/i, "").trim();
    await handleModelCommand(
      {
        config: context.runtime.config,
        configPath: context.runtime.configPath,
        onConfigUpdate: context.runtime.updateConfig,
      },
      {
        output: (text) => context.io.stdout(text),
        error: (text) => context.io.stderr(text),
      },
      args
    );
    return true;
  }

  if (/^(\/exit|quit|exit)$/i.test(input)) {
    const goodbye = "Goodbye.";
    context.io.stdout(`${goodbye}\n`);
    recordAssistantMessage(context.getSession(), context.conversation, "assistant", goodbye);
    return true;
  }

  return false;
}
