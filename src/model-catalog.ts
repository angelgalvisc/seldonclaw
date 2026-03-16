/**
 * model-catalog.ts — Curated provider + model catalog for onboarding and /model
 */

export type SupportedProvider = "anthropic" | "openai" | "moonshot";

export interface ModelPreset {
  id: string;
  label: string;
  tier: "best" | "recommended" | "fast";
  persistedId?: string;
  aliases?: string[];
}

export interface ProviderCatalogEntry {
  id: SupportedProvider;
  label: string;
  description: string;
  apiKeyEnv: string;
  baseUrl?: string;
  models: ModelPreset[];
}

export const PROVIDER_CATALOG: Record<SupportedProvider, ProviderCatalogEntry> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    description: "Claude models with strong reasoning defaults for simulation and analysis.",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    models: [
      {
        id: "claude-opus-4-6",
        label: "Claude Opus 4.6",
        tier: "best",
      },
      {
        id: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        tier: "recommended",
      },
      {
        id: "claude-haiku-4-5",
        label: "Claude Haiku 4.5",
        tier: "fast",
        aliases: ["claude-haiku-4-5-20251001"],
      },
    ],
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    description: "GPT-5 family models with modern API support and broad ecosystem familiarity.",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    models: [
      {
        id: "gpt-5.4",
        persistedId: "gpt-5.4-2026-03-05",
        label: "GPT-5.4",
        tier: "recommended",
      },
      {
        id: "gpt-5-mini",
        persistedId: "gpt-5-mini-2025-08-07",
        label: "GPT-5 mini",
        tier: "fast",
      },
      {
        id: "gpt-5-nano",
        persistedId: "gpt-5-nano-2025-08-07",
        label: "GPT-5 nano",
        tier: "fast",
      },
    ],
  },
  moonshot: {
    id: "moonshot",
    label: "Moonshot AI",
    description: "Kimi models through Moonshot Open Platform and an OpenAI-compatible endpoint.",
    apiKeyEnv: "MOONSHOT_API_KEY",
    baseUrl: "https://api.moonshot.cn/v1",
    models: [
      {
        id: "moonshot/kimi-k2.5",
        label: "Kimi K2.5",
        tier: "recommended",
        aliases: ["kimi-k2.5"],
      },
      {
        id: "kimi-k2-thinking",
        label: "Kimi K2 Thinking",
        tier: "best",
      },
      {
        id: "kimi-k2-thinking-turbo",
        label: "Kimi K2 Thinking Turbo",
        tier: "fast",
      },
    ],
  },
};

export const SUPPORTED_PROVIDERS = Object.keys(PROVIDER_CATALOG) as SupportedProvider[];

export function getProviderCatalog(provider: SupportedProvider): ProviderCatalogEntry {
  return PROVIDER_CATALOG[provider];
}

export function getRecommendedModel(provider: SupportedProvider): ModelPreset {
  return PROVIDER_CATALOG[provider].models.find((model) => model.tier === "recommended")
    ?? PROVIDER_CATALOG[provider].models[0];
}

export function resolveModelPreset(
  provider: SupportedProvider,
  input: string
): ModelPreset | undefined {
  const query = input.trim().toLowerCase();
  return PROVIDER_CATALOG[provider].models.find((preset) => {
    const candidates = [
      preset.id,
      preset.persistedId,
      preset.label,
      ...(preset.aliases ?? []),
    ]
      .filter(Boolean)
      .map((candidate) => candidate!.toLowerCase());
    return candidates.includes(query);
  });
}

export function normalizeModelId(provider: SupportedProvider, input: string): string {
  const preset = resolveModelPreset(provider, input);
  return preset?.persistedId ?? preset?.id ?? input.trim();
}

export function describeConfiguredModel(provider: SupportedProvider, modelId: string): string {
  const preset = resolveModelPreset(provider, modelId);
  return preset ? preset.label : modelId;
}

export function parseProvider(input: string): SupportedProvider | undefined {
  const query = input.trim().toLowerCase();
  if (query === "anthropic" || query === "claude") return "anthropic";
  if (query === "openai" || query === "chatgpt" || query === "gpt") return "openai";
  if (query === "moonshot" || query === "moonshot ai" || query === "kimi") return "moonshot";
  return undefined;
}
