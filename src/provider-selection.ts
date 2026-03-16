/**
 * provider-selection.ts — Provider/model resolution and editing helpers
 *
 * Centralizes:
 * - provider roles
 * - config shapes for provider defaults and overrides
 * - normalization from legacy per-role configs
 * - resolved config lookup per role
 * - helper mutations for global and per-role model switching
 */

import {
  getProviderCatalog,
  getRecommendedModel,
  normalizeModelId,
  parseProvider,
  type SupportedProvider,
} from "./model-catalog.js";

export const PROVIDER_ROLES = ["analysis", "generation", "simulation", "report"] as const;
export type ProviderRole = (typeof PROVIDER_ROLES)[number];

export interface ProviderConfig {
  provider: SupportedProvider;
  sdk?: string;
  model: string;
  apiKeyEnv: string;
  baseUrl?: string;
}

export interface ProviderOverrideConfig {
  provider?: SupportedProvider;
  sdk?: string;
  model?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
}

export type ProviderOverridesConfig = Partial<Record<ProviderRole, ProviderOverrideConfig>>;

export interface ProvidersConfig {
  default: ProviderConfig;
  overrides: ProviderOverridesConfig;
}

export function inferProviderFromLegacyConfig(
  provider: Partial<ProviderConfig> | ProviderOverrideConfig | undefined
): SupportedProvider {
  if (provider?.provider && parseProvider(provider.provider)) {
    return provider.provider;
  }
  if (provider?.sdk && parseProvider(provider.sdk)) {
    return parseProvider(provider.sdk)!;
  }
  if (provider?.baseUrl?.includes("moonshot")) return "moonshot";
  if (provider?.baseUrl?.includes("openai")) return "openai";
  return "anthropic";
}

export function createProviderConfig(
  provider: SupportedProvider,
  model?: string,
  overrides: Partial<Omit<ProviderConfig, "provider" | "sdk" | "model">> = {}
): ProviderConfig {
  const entry = getProviderCatalog(provider);
  const normalizedModel = normalizeModelId(provider, model ?? getRecommendedModel(provider).id);
  const baseUrl = overrides.baseUrl ?? entry.baseUrl;
  return {
    provider,
    sdk: provider,
    model: normalizedModel,
    apiKeyEnv: overrides.apiKeyEnv ?? entry.apiKeyEnv,
    ...(baseUrl ? { baseUrl } : {}),
  };
}

function normalizeProviderOverride(input: unknown): ProviderOverrideConfig | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const provider = inferProviderFromLegacyConfig({
    provider:
      typeof raw.provider === "string" && parseProvider(raw.provider)
        ? parseProvider(raw.provider)
        : undefined,
    sdk: typeof raw.sdk === "string" ? raw.sdk : undefined,
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : undefined,
  });

  const override: ProviderOverrideConfig = {};
  if (typeof raw.provider === "string" || typeof raw.sdk === "string" || typeof raw.baseUrl === "string") {
    override.provider = provider;
  }
  if (typeof raw.sdk === "string" && raw.sdk.trim()) override.sdk = raw.sdk.trim();
  if (typeof raw.model === "string" && raw.model.trim()) override.model = raw.model.trim();
  if (typeof raw.apiKeyEnv === "string" && raw.apiKeyEnv.trim()) {
    override.apiKeyEnv = raw.apiKeyEnv.trim();
  }
  if (typeof raw.baseUrl === "string" && raw.baseUrl.trim()) {
    override.baseUrl = raw.baseUrl.trim();
  }

  return Object.keys(override).length > 0 ? override : undefined;
}

function resolveAgainstBase(
  partial: ProviderOverrideConfig | undefined,
  base: ProviderConfig
): ProviderConfig {
  if (!partial) return createProviderConfig(base.provider, base.model, base);

  const provider = partial.provider ?? base.provider;
  const providerChanged = provider !== base.provider;
  const entry = getProviderCatalog(provider);
  const model = partial.model ?? (providerChanged ? getRecommendedModel(provider).id : base.model);
  const apiKeyEnv = partial.apiKeyEnv ?? (providerChanged ? entry.apiKeyEnv : base.apiKeyEnv);
  const baseUrl =
    partial.baseUrl ?? (providerChanged ? entry.baseUrl : base.baseUrl);

  return createProviderConfig(provider, model, {
    apiKeyEnv,
    ...(baseUrl ? { baseUrl } : {}),
  });
}

function diffProviderConfig(
  base: ProviderConfig,
  next: ProviderConfig
): ProviderOverrideConfig | undefined {
  const override: ProviderOverrideConfig = {};
  if (next.provider !== base.provider) override.provider = next.provider;
  if (next.model !== base.model) override.model = next.model;
  if (next.apiKeyEnv !== base.apiKeyEnv) override.apiKeyEnv = next.apiKeyEnv;
  if ((next.baseUrl ?? "") !== (base.baseUrl ?? "")) override.baseUrl = next.baseUrl;
  return Object.keys(override).length > 0 ? override : undefined;
}

function normalizeLegacyProviders(
  raw: Record<string, unknown>,
  fallback: ProvidersConfig
): ProvidersConfig {
  const firstRole =
    PROVIDER_ROLES.find((role) => raw[role] && typeof raw[role] === "object") ?? "simulation";
  const baseOverride = normalizeProviderOverride(raw[firstRole]);
  const defaultProvider = resolveAgainstBase(baseOverride, fallback.default);
  const overrides: ProviderOverridesConfig = {};

  for (const role of PROVIDER_ROLES) {
    const roleOverride = normalizeProviderOverride(raw[role]);
    if (!roleOverride) continue;
    const resolved = resolveAgainstBase(roleOverride, fallback.default);
    const diff = diffProviderConfig(defaultProvider, resolved);
    if (diff) overrides[role] = diff;
  }

  return { default: defaultProvider, overrides };
}

export function normalizeProvidersConfig(
  raw: unknown,
  fallback: ProvidersConfig
): ProvidersConfig {
  if (!raw || typeof raw !== "object") {
    return {
      default: createProviderConfig(fallback.default.provider, fallback.default.model, fallback.default),
      overrides: structuredClone(fallback.overrides),
    };
  }

  const source = raw as Record<string, unknown>;
  const hasLegacyRoles = PROVIDER_ROLES.some((role) => role in source);
  if (hasLegacyRoles) {
    return normalizeLegacyProviders(source, fallback);
  }

  const defaultOverride = normalizeProviderOverride(source.default);
  const defaultProvider = resolveAgainstBase(defaultOverride, fallback.default);
  const overridesRaw =
    source.overrides && typeof source.overrides === "object"
      ? (source.overrides as Record<string, unknown>)
      : {};
  const overrides: ProviderOverridesConfig = {};

  for (const role of PROVIDER_ROLES) {
    const partial = normalizeProviderOverride(overridesRaw[role]);
    if (!partial) continue;
    const resolved = resolveAgainstBase(partial, defaultProvider);
    const diff = diffProviderConfig(defaultProvider, resolved);
    if (diff) overrides[role] = diff;
  }

  return { default: defaultProvider, overrides };
}

export function resolveProviderConfig(
  providers: ProvidersConfig,
  role: ProviderRole
): ProviderConfig {
  return resolveAgainstBase(providers.overrides[role], providers.default);
}

export function resolveProviderConfigs(
  providers: ProvidersConfig
): Record<ProviderRole, ProviderConfig> {
  return {
    analysis: resolveProviderConfig(providers, "analysis"),
    generation: resolveProviderConfig(providers, "generation"),
    simulation: resolveProviderConfig(providers, "simulation"),
    report: resolveProviderConfig(providers, "report"),
  };
}

export function setGlobalProviderSelection(
  providers: ProvidersConfig,
  provider: SupportedProvider,
  model?: string
): ProvidersConfig {
  return {
    default: createProviderConfig(provider, model),
    overrides: {},
  };
}

export function setRoleProviderSelection(
  providers: ProvidersConfig,
  role: ProviderRole,
  selection: Partial<ProviderConfig>
): ProvidersConfig {
  const base = providers.default;
  const current = resolveProviderConfig(providers, role);
  const requestedProvider = selection.provider ?? current.provider;
  const nextResolved = resolveAgainstBase(
    {
      provider: requestedProvider,
      model: selection.model ?? current.model,
      apiKeyEnv: selection.apiKeyEnv ?? current.apiKeyEnv,
      baseUrl: selection.baseUrl ?? current.baseUrl,
    },
    base
  );
  const diff = diffProviderConfig(base, nextResolved);
  const next: ProvidersConfig = {
    default: createProviderConfig(base.provider, base.model, base),
    overrides: { ...providers.overrides },
  };
  if (diff) next.overrides[role] = diff;
  else delete next.overrides[role];
  return next;
}

export function clearRoleProviderOverride(
  providers: ProvidersConfig,
  role: ProviderRole
): ProvidersConfig {
  const next: ProvidersConfig = {
    default: createProviderConfig(
      providers.default.provider,
      providers.default.model,
      providers.default
    ),
    overrides: { ...providers.overrides },
  };
  delete next.overrides[role];
  return next;
}

export function hasRoleOverride(providers: ProvidersConfig, role: ProviderRole): boolean {
  return Boolean(providers.overrides[role]);
}
