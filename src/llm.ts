/**
 * llm.ts — Multi-provider LLM client for Anthropic, OpenAI, and Moonshot AI
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { getProviderCatalog } from "./model-catalog.js";
import {
  PROVIDER_ROLES,
  createProviderConfig,
  resolveProviderConfig,
  type ProviderConfig,
  type ProviderRole,
  type ProvidersConfig,
} from "./provider-selection.js";

export interface LLMResponse {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}

export interface LLMRequestOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
}

type RuntimeClient =
  | {
      kind: "anthropic";
      client: Anthropic;
      config: ProviderConfig;
    }
  | {
      kind: "openai" | "moonshot";
      client: OpenAI;
      config: ProviderConfig;
    };

const COST_PER_MILLION: Record<string, { input: number; output: number }> = {
  "claude-opus-4-6": { input: 15.0, output: 75.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5": { input: 0.8, output: 4.0 },
  "gpt-5.4": { input: 5.0, output: 15.0 },
  "gpt-5.4-2026-03-05": { input: 5.0, output: 15.0 },
  "gpt-5-mini": { input: 0.6, output: 2.4 },
  "gpt-5-mini-2025-08-07": { input: 0.6, output: 2.4 },
  "gpt-5-nano": { input: 0.15, output: 0.6 },
  "gpt-5-nano-2025-08-07": { input: 0.15, output: 0.6 },
  "moonshot/kimi-k2.5": { input: 1.0, output: 4.0 },
  "kimi-k2.5": { input: 1.0, output: 4.0 },
  "kimi-k2-thinking": { input: 1.0, output: 4.0 },
  "kimi-k2-thinking-turbo": { input: 0.6, output: 2.4 },
  default: { input: 3.0, output: 15.0 },
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = COST_PER_MILLION[model] ?? COST_PER_MILLION.default;
  return (
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output
  );
}

export class LLMClient {
  private clients: Map<ProviderRole, RuntimeClient> = new Map();
  private readonly configs: ProvidersConfig;

  constructor(providers: ProvidersConfig) {
    this.configs = providers;

    for (const role of PROVIDER_ROLES) {
      const providerConfig = resolveProviderConfig(providers, role);
      const apiKey = process.env[providerConfig.apiKeyEnv];
      if (!apiKey) continue;

      if (providerConfig.provider === "anthropic") {
        this.clients.set(role, {
          kind: "anthropic",
          client: new Anthropic({ apiKey }),
          config: providerConfig,
        });
        continue;
      }

      const baseUrl =
        providerConfig.baseUrl ?? getProviderCatalog(providerConfig.provider).baseUrl;
      this.clients.set(role, {
        kind: providerConfig.provider,
        client: new OpenAI({ apiKey, baseURL: baseUrl }),
        config: providerConfig,
      });
    }
  }

  hasProvider(role: ProviderRole): boolean {
    return this.clients.has(role);
  }

  getModel(role: ProviderRole): string {
    return this.getRuntime(role).config.model;
  }

  getProviderConfig(role: ProviderRole): ProviderConfig {
    return resolveProviderConfig(this.configs, role);
  }

  async complete(
    role: ProviderRole,
    prompt: string,
    options: LLMRequestOptions = {}
  ): Promise<LLMResponse> {
    const runtime = this.getRuntime(role);
    switch (runtime.kind) {
      case "anthropic":
        return completeAnthropic(runtime.client, runtime.config, prompt, options);
      case "openai":
      case "moonshot":
        return completeOpenAICompatible(runtime.client, runtime.config, prompt, options);
    }
  }

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

    let jsonStr = response.content.trim();
    if (jsonStr.startsWith("```json")) jsonStr = jsonStr.slice(7);
    else if (jsonStr.startsWith("```")) jsonStr = jsonStr.slice(3);
    if (jsonStr.endsWith("```")) jsonStr = jsonStr.slice(0, -3);
    jsonStr = jsonStr.trim();

    let data: T;
    try {
      data = JSON.parse(jsonStr) as T;
    } catch {
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

  async chat(
    role: ProviderRole,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    options: LLMRequestOptions = {}
  ): Promise<LLMResponse> {
    const runtime = this.getRuntime(role);
    switch (runtime.kind) {
      case "anthropic":
        return chatAnthropic(runtime.client, runtime.config, messages, options);
      case "openai":
      case "moonshot":
        return chatOpenAICompatible(runtime.client, runtime.config, messages, options);
    }
  }

  private getRuntime(role: ProviderRole): RuntimeClient {
    const client = this.clients.get(role);
    if (!client) {
      const config = resolveProviderConfig(this.configs, role);
      const envVar = config?.apiKeyEnv ?? "the configured API key env var";
      throw new Error(`Provider "${role}" not configured. Set ${envVar}.`);
    }
    return client;
  }
}

async function completeAnthropic(
  client: Anthropic,
  config: ProviderConfig,
  prompt: string,
  options: LLMRequestOptions
): Promise<LLMResponse> {
  const startTime = Date.now();
  const response = await client.messages.create({
    model: config.model,
    max_tokens: options.maxTokens ?? 4096,
    temperature: options.temperature ?? 0.0,
    system: options.system,
    messages: [{ role: "user", content: prompt }],
    ...(options.stopSequences ? { stop_sequences: options.stopSequences } : {}),
  });

  const textBlocks = response.content.filter(
    (block): block is Anthropic.Messages.TextBlock => block.type === "text"
  );
  const content = textBlocks.map((block) => block.text).join("");
  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;

  return {
    content,
    model: config.model,
    inputTokens,
    outputTokens,
    costUsd: estimateCost(config.model, inputTokens, outputTokens),
    durationMs: Date.now() - startTime,
  };
}

async function chatAnthropic(
  client: Anthropic,
  config: ProviderConfig,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  options: LLMRequestOptions
): Promise<LLMResponse> {
  const startTime = Date.now();
  const response = await client.messages.create({
    model: config.model,
    max_tokens: options.maxTokens ?? 4096,
    temperature: options.temperature ?? 0.0,
    system: options.system,
    messages: messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    ...(options.stopSequences ? { stop_sequences: options.stopSequences } : {}),
  });

  const textBlocks = response.content.filter(
    (block): block is Anthropic.Messages.TextBlock => block.type === "text"
  );
  const content = textBlocks.map((block) => block.text).join("");
  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;

  return {
    content,
    model: config.model,
    inputTokens,
    outputTokens,
    costUsd: estimateCost(config.model, inputTokens, outputTokens),
    durationMs: Date.now() - startTime,
  };
}

async function completeOpenAICompatible(
  client: OpenAI,
  config: ProviderConfig,
  prompt: string,
  options: LLMRequestOptions
): Promise<LLMResponse> {
  return chatOpenAICompatible(
    client,
    config,
    [{ role: "user", content: prompt }],
    options
  );
}

async function chatOpenAICompatible(
  client: OpenAI,
  config: ProviderConfig,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  options: LLMRequestOptions
): Promise<LLMResponse> {
  const startTime = Date.now();
  const response = await client.chat.completions.create({
    model: config.model,
    messages: [
      ...(options.system ? [{ role: "system" as const, content: options.system }] : []),
      ...messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ],
    temperature: options.temperature ?? 0.0,
    max_completion_tokens: options.maxTokens ?? 4096,
    ...(options.stopSequences ? { stop: options.stopSequences } : {}),
  });

  const content = response.choices[0]?.message?.content ?? "";
  const inputTokens = response.usage?.prompt_tokens ?? 0;
  const outputTokens = response.usage?.completion_tokens ?? 0;

  return {
    content,
    model: config.model,
    inputTokens,
    outputTokens,
    costUsd: estimateCost(config.model, inputTokens, outputTokens),
    durationMs: Date.now() - startTime,
  };
}

export async function validateProviderConnection(config: ProviderConfig): Promise<void> {
  const apiKey = process.env[config.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Missing ${config.apiKeyEnv}`);
  }

  if (config.provider === "anthropic") {
    const client = new Anthropic({ apiKey });
    await client.messages.create({
      model: config.model,
      max_tokens: 8,
      temperature: 0,
      messages: [{ role: "user", content: "Reply with OK." }],
    });
    return;
  }

  const client = new OpenAI({
    apiKey,
    baseURL: config.baseUrl ?? getProviderCatalog(config.provider).baseUrl,
  });

  await client.chat.completions.create({
    model: config.model,
    messages: [{ role: "user", content: "Reply with OK." }],
    temperature: 0,
    max_completion_tokens: 8,
  });
}

export class MockLLMClient extends LLMClient {
  private responses: Map<string, string> = new Map();

  constructor() {
    super({
      default: createProviderConfig("anthropic", "mock-model", { apiKeyEnv: "MOCK" }),
      overrides: {},
    });
  }

  setResponse(promptContains: string, response: string): void {
    this.responses.set(promptContains, response);
  }

  override async complete(
    _role: ProviderRole,
    prompt: string,
    _options: LLMRequestOptions = {}
  ): Promise<LLMResponse> {
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
    options: LLMRequestOptions = {}
  ): Promise<LLMResponse> {
    const lastUserMsg = [...messages].reverse().find((message) => message.role === "user");
    return this.complete(role, lastUserMsg?.content ?? "", options);
  }

  override hasProvider(_role: ProviderRole): boolean {
    return true;
  }

  override getModel(_role: ProviderRole): string {
    return "mock-model";
  }
}
