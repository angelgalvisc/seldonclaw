/**
 * assistant-planner.ts — LLM planning loop for the PublicMachina operator.
 */

import type { LLMClient, LLMResponse } from "./llm.js";
import type { AssistantToolDefinition, AssistantToolName } from "./assistant-tools.js";

export type AssistantPlannerDecision =
  | {
      kind: "respond";
      message: string;
      meta: AssistantPlannerMeta;
    }
  | {
      kind: "tool_call";
      tool: AssistantToolName;
      arguments: Record<string, unknown>;
      meta: AssistantPlannerMeta;
    };

export interface AssistantPlannerInput {
  contextSummary: string;
  currentTaskSummary: string;
  conversation: Array<{ role: "user" | "assistant"; content: string }>;
  userInput: string;
  tools: AssistantToolDefinition[];
  toolTrace?: string[];
}

interface PlannerJson {
  kind?: unknown;
  message?: unknown;
  tool?: unknown;
  arguments?: unknown;
}

export interface AssistantPlannerMeta {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export async function planAssistantStep(
  llm: LLMClient,
  input: AssistantPlannerInput
): Promise<AssistantPlannerDecision> {
  const prompt = buildPlannerPrompt(input);
  const system = buildPlannerSystemPrompt();
  const attempts: AssistantPlannerMeta[] = [];
  const initial = await requestPlannerJson(llm, prompt, system, 800);
  attempts.push(initial.meta);

  let data = initial.data;
  if (!data) {
    const repair = await requestPlannerJson(
      llm,
      buildRepairPrompt(input, initial.raw),
      buildRepairSystemPrompt(),
      400
    );
    attempts.push(repair.meta);
    data = repair.data;
  }

  return finalizePlannerDecision(input, data, mergePlannerMeta(attempts));
}

function buildPlannerPrompt(input: AssistantPlannerInput): string {
  return [
    "Operator workspace context:",
    input.contextSummary.trim() || "No workspace context available.",
    "",
    "Current task state:",
    input.currentTaskSummary.trim() || "No active task.",
    "",
    "Recent conversation:",
    formatConversation(input.conversation),
    "",
    input.toolTrace && input.toolTrace.length > 0
      ? `Tool trace so far:\n${input.toolTrace.join("\n")}\n`
      : "",
    `Latest user input:\n${input.userInput.trim()}`,
    "",
    "Available tools:",
    renderTools(input.tools),
  ]
    .filter(Boolean)
    .join("\n");
}

function buildPlannerSystemPrompt(): string {
  return [
    "You are PublicMachina, an operator assistant for public narrative simulations.",
    "You can either answer directly or choose exactly one tool call per step.",
    "Use tools when the user is asking you to design, run, inspect, report, export, query, interview, review history, or switch providers/models.",
    "Do not call run_simulation unless the user is asking to run a simulation or confirming a run.",
    "Do not invent file paths, actor names, or run IDs when the current task state already has them.",
    "If the user is making a conversational or strategic request, answer directly.",
    "Return JSON only.",
    'JSON schema: {"kind":"respond","message":"..."} or {"kind":"tool_call","tool":"...","arguments":{...}}',
  ].join("\n");
}

function buildRepairSystemPrompt(): string {
  return [
    "You repair planner outputs for PublicMachina.",
    "Return valid JSON only.",
    'Target schema: {"kind":"respond","message":"..."} or {"kind":"tool_call","tool":"...","arguments":{...}}',
    "If the source output is truncated, infer the smallest valid JSON that preserves the original intent.",
    "Do not include markdown fences or commentary.",
  ].join("\n");
}

function buildRepairPrompt(input: AssistantPlannerInput, raw: string): string {
  return [
    "The previous planner response was invalid JSON. Repair it.",
    `Latest user input: ${input.userInput.trim()}`,
    `Current task summary: ${input.currentTaskSummary.trim() || "No active task."}`,
    `Known tools: ${input.tools.map((tool) => tool.name).join(", ")}`,
    "Broken planner output:",
    raw.trim() || "(empty response)",
  ].join("\n");
}

async function requestPlannerJson(
  llm: LLMClient,
  prompt: string,
  system: string,
  maxTokens: number
): Promise<{ data: PlannerJson | null; raw: string; meta: AssistantPlannerMeta }> {
  const response = await llm.complete("simulation", prompt, {
    system,
    temperature: 0.0,
    maxTokens,
  });

  return {
    data: parsePlannerJson(response.content),
    raw: response.content,
    meta: toPlannerMeta(response),
  };
}

function finalizePlannerDecision(
  input: AssistantPlannerInput,
  data: PlannerJson | null,
  meta: AssistantPlannerMeta
): AssistantPlannerDecision {
  if (!data) {
    return {
      kind: "respond",
      message: "I need a bit more specificity before I act. Tell me whether you want me to design, run, inspect, report on, or compare a simulation.",
      meta,
    };
  }

  if (data.kind === "respond" && typeof data.message === "string" && data.message.trim()) {
    return {
      kind: "respond",
      message: data.message.trim(),
      meta,
    };
  }

  if (
    data.kind === "tool_call" &&
    typeof data.tool === "string" &&
    input.tools.some((tool) => tool.name === data.tool) &&
    isObject(data.arguments)
  ) {
    return {
      kind: "tool_call",
      tool: data.tool as AssistantToolName,
      arguments: data.arguments,
      meta,
    };
  }

  return {
    kind: "respond",
    message: "I need a bit more specificity before I act. Tell me whether you want me to design, run, inspect, report on, or compare a simulation.",
    meta,
  };
}

function toPlannerMeta(response: LLMResponse): AssistantPlannerMeta {
  return {
    costUsd: response.costUsd,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    model: response.model,
  };
}

function mergePlannerMeta(attempts: AssistantPlannerMeta[]): AssistantPlannerMeta {
  return attempts.reduce<AssistantPlannerMeta>(
    (acc, meta) => ({
      costUsd: acc.costUsd + meta.costUsd,
      inputTokens: acc.inputTokens + meta.inputTokens,
      outputTokens: acc.outputTokens + meta.outputTokens,
      model: meta.model || acc.model,
    }),
    { costUsd: 0, inputTokens: 0, outputTokens: 0, model: "" }
  );
}

function parsePlannerJson(raw: string): PlannerJson | null {
  for (const candidate of plannerJsonCandidates(raw)) {
    try {
      return JSON.parse(candidate) as PlannerJson;
    } catch {
      continue;
    }
  }
  return null;
}

function plannerJsonCandidates(raw: string): string[] {
  const normalized = normalizePlannerResponse(raw);
  const candidates = [normalized];
  const firstBrace = normalized.indexOf("{");
  const lastBrace = normalized.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(normalized.slice(firstBrace, lastBrace + 1));
  }
  return [...new Set(candidates.map((item) => item.trim()).filter(Boolean))];
}

function normalizePlannerResponse(raw: string): string {
  let text = raw.trim();
  if (text.startsWith("```json")) text = text.slice(7);
  else if (text.startsWith("```")) text = text.slice(3);
  if (text.endsWith("```")) text = text.slice(0, -3);
  return text.trim();
}

function renderTools(tools: AssistantToolDefinition[]): string {
  return tools
    .map((tool) => {
      const params = Object.entries(tool.parameters)
        .map(([name, description]) => `  - ${name}: ${description}`)
        .join("\n");
      return `${tool.name}: ${tool.description}\n${params}`;
    })
    .join("\n\n");
}

function formatConversation(
  conversation: Array<{ role: "user" | "assistant"; content: string }>
): string {
  if (conversation.length === 0) {
    return "- No conversation yet in this session.";
  }
  return conversation
    .slice(-10)
    .map((message) => `- ${message.role}: ${message.content}`)
    .join("\n");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
