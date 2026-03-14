/**
 * llm.ts — Multi-provider LLM client (Anthropic native SDK)
 *
 * Source of truth: PLAN.md §Dependencies (lines 1593-1619),
 *                  §SimConfig providers (lines 1492-1507)
 *
 * All structured extraction uses @anthropic-ai/sdk natively.
 * NullClaw manages its own LLM client internally — not our concern here.
 * This client is used for: ontology, profiles, report, interview.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ProvidersConfig, ProviderConfig } from "./config.js";

// ═══════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════

export type ProviderRole = "analysis" | "generation" | "simulation" | "report";

export interface LLMResponse {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}

export interface LLMRequestOptions {
  /** System prompt */
  system?: string;
  /** Max tokens for the response */
  maxTokens?: number;
  /** Temperature (0.0-1.0) */
  temperature?: number;
  /** Stop sequences */
  stopSequences?: string[];
}

// ═══════════════════════════════════════════════════════
// COST TABLE — approximate per-model pricing (per 1M tokens)
// ═══════════════════════════════════════════════════════

const COST_PER_MILLION: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-haiku-4-20250414": { input: 0.80, output: 4.0 },
  // Fallback for unknown models
  default: { input: 3.0, output: 15.0 },
};

function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing =
    COST_PER_MILLION[model] ?? COST_PER_MILLION["default"];
  return (
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output
  );
}

// ═══════════════════════════════════════════════════════
// LLM CLIENT
// ═══════════════════════════════════════════════════════

export class LLMClient {
  private clients: Map<ProviderRole, { anthropic: Anthropic; config: ProviderConfig }> =
    new Map();

  constructor(providers: ProvidersConfig) {
    for (const role of ["analysis", "generation", "simulation", "report"] as ProviderRole[]) {
      const providerConfig = providers[role];
      if (!providerConfig) continue;

      const apiKey = process.env[providerConfig.apiKeyEnv];
      if (!apiKey) {
        // Don't throw — the provider might not be needed yet
        // (e.g., simulation provider is for NullClaw, not this client)
        continue;
      }

      const anthropic = new Anthropic({ apiKey });
      this.clients.set(role, { anthropic, config: providerConfig });
    }
  }

  /**
   * Check if a provider role is available (has API key set).
   */
  hasProvider(role: ProviderRole): boolean {
    return this.clients.has(role);
  }

  /**
   * Get the model name for a provider role.
   */
  getModel(role: ProviderRole): string {
    const client = this.clients.get(role);
    if (!client) throw new Error(`Provider "${role}" not configured or API key missing`);
    return client.config.model;
  }

  /**
   * Send a prompt to the specified provider role and get a text response.
   */
  async complete(
    role: ProviderRole,
    prompt: string,
    options: LLMRequestOptions = {}
  ): Promise<LLMResponse> {
    const client = this.clients.get(role);
    if (!client) {
      throw new Error(
        `Provider "${role}" not configured. Set ${role === "analysis" ? "ANTHROPIC_API_KEY" : "the appropriate env var"}.`
      );
    }

    const startTime = Date.now();

    const messages: Anthropic.Messages.MessageParam[] = [
      { role: "user", content: prompt },
    ];

    const response = await client.anthropic.messages.create({
      model: client.config.model,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.0,
      system: options.system,
      messages,
      ...(options.stopSequences
        ? { stop_sequences: options.stopSequences }
        : {}),
    });

    const durationMs = Date.now() - startTime;
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;

    // Extract text content
    const textBlocks = response.content.filter(
      (block): block is Anthropic.Messages.TextBlock => block.type === "text"
    );
    const content = textBlocks.map((b) => b.text).join("");

    return {
      content,
      model: client.config.model,
      inputTokens,
      outputTokens,
      costUsd: estimateCost(client.config.model, inputTokens, outputTokens),
      durationMs,
    };
  }

  /**
   * Send a prompt and parse the response as JSON.
   * Uses structured output prompting to get valid JSON.
   */
  async completeJSON<T = unknown>(
    role: ProviderRole,
    prompt: string,
    options: LLMRequestOptions = {}
  ): Promise<{ data: T; meta: Omit<LLMResponse, "content"> }> {
    const systemPrompt = [
      options.system ?? "",
      "You MUST respond with valid JSON only. No markdown code fences, no explanatory text before or after the JSON.",
    ]
      .filter(Boolean)
      .join("\n\n");

    const response = await this.complete(role, prompt, {
      ...options,
      system: systemPrompt,
      temperature: options.temperature ?? 0.0,
    });

    // Strip any markdown code fences that models sometimes add
    let jsonStr = response.content.trim();
    if (jsonStr.startsWith("```json")) {
      jsonStr = jsonStr.slice(7);
    } else if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.slice(3);
    }
    if (jsonStr.endsWith("```")) {
      jsonStr = jsonStr.slice(0, -3);
    }
    jsonStr = jsonStr.trim();

    let data: T;
    try {
      data = JSON.parse(jsonStr) as T;
    } catch (e) {
      throw new Error(
        `Failed to parse LLM JSON response from ${role} (model: ${response.model}):\n${jsonStr.slice(0, 200)}`
      );
    }

    return {
      data,
      meta: {
        model: response.model,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        costUsd: response.costUsd,
        durationMs: response.durationMs,
      },
    };
  }

  /**
   * Send a multi-turn conversation.
   */
  async chat(
    role: ProviderRole,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    options: LLMRequestOptions = {}
  ): Promise<LLMResponse> {
    const client = this.clients.get(role);
    if (!client) {
      throw new Error(`Provider "${role}" not configured.`);
    }

    const startTime = Date.now();

    const response = await client.anthropic.messages.create({
      model: client.config.model,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.0,
      system: options.system,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      ...(options.stopSequences
        ? { stop_sequences: options.stopSequences }
        : {}),
    });

    const durationMs = Date.now() - startTime;
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;

    const textBlocks = response.content.filter(
      (block): block is Anthropic.Messages.TextBlock => block.type === "text"
    );
    const content = textBlocks.map((b) => b.text).join("");

    return {
      content,
      model: client.config.model,
      inputTokens,
      outputTokens,
      costUsd: estimateCost(client.config.model, inputTokens, outputTokens),
      durationMs,
    };
  }
}

/**
 * Create a mock LLM client for tests (returns canned responses).
 */
export class MockLLMClient extends LLMClient {
  private responses: Map<string, string> = new Map();

  constructor() {
    // Pass empty providers — mock doesn't need real API keys
    super({
      analysis: { sdk: "anthropic", model: "mock-model", apiKeyEnv: "MOCK" },
      generation: { sdk: "anthropic", model: "mock-model", apiKeyEnv: "MOCK" },
      simulation: { model: "mock-model", apiKeyEnv: "MOCK" },
      report: { sdk: "anthropic", model: "mock-model", apiKeyEnv: "MOCK" },
    });
  }

  /**
   * Register a canned response for a specific prompt pattern.
   */
  setResponse(promptContains: string, response: string): void {
    this.responses.set(promptContains, response);
  }

  override async complete(
    role: ProviderRole,
    prompt: string,
    _options: LLMRequestOptions = {}
  ): Promise<LLMResponse> {
    // Find matching canned response
    for (const [pattern, response] of this.responses) {
      if (prompt.includes(pattern)) {
        return {
          content: response,
          model: "mock-model",
          inputTokens: Math.ceil(prompt.length / 4),
          outputTokens: Math.ceil(response.length / 4),
          costUsd: 0,
          durationMs: 1,
        };
      }
    }

    // Default response
    return {
      content: "{}",
      model: "mock-model",
      inputTokens: Math.ceil(prompt.length / 4),
      outputTokens: 1,
      costUsd: 0,
      durationMs: 1,
    };
  }

  override async chat(
    role: ProviderRole,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    _options: LLMRequestOptions = {}
  ): Promise<LLMResponse> {
    // Use last user message for matching, same logic as complete()
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    const prompt = lastUserMsg?.content ?? "";
    return this.complete(role, prompt, _options);
  }

  override hasProvider(_role: ProviderRole): boolean {
    return true;
  }

  override getModel(_role: ProviderRole): string {
    return "mock-model";
  }
}
