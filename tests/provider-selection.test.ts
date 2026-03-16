import { describe, expect, it } from "vitest";
import {
  clearRoleProviderOverride,
  createProviderConfig,
  normalizeProvidersConfig,
  resolveProviderConfig,
  setGlobalProviderSelection,
  setRoleProviderSelection,
} from "../src/provider-selection.js";

describe("provider-selection.ts", () => {
  const fallback = {
    default: createProviderConfig("anthropic", "claude-sonnet-4-6"),
    overrides: {},
  };

  it("resolves default provider config for all roles when no overrides exist", () => {
    const resolved = resolveProviderConfig(fallback, "simulation");
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.model).toBe("claude-sonnet-4-6");
    expect(resolved.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
  });

  it("normalizes legacy per-role provider blocks into default + overrides", () => {
    const normalized = normalizeProvidersConfig(
      {
        analysis: {
          sdk: "anthropic",
          model: "claude-sonnet-4-6",
          apiKeyEnv: "ANTHROPIC_API_KEY",
        },
        generation: {
          sdk: "anthropic",
          model: "claude-sonnet-4-6",
          apiKeyEnv: "ANTHROPIC_API_KEY",
        },
        simulation: {
          sdk: "anthropic",
          model: "claude-sonnet-4-6",
          apiKeyEnv: "ANTHROPIC_API_KEY",
        },
        report: {
          provider: "openai",
          model: "gpt-5-mini",
          apiKeyEnv: "OPENAI_API_KEY",
        },
      },
      fallback
    );

    expect(normalized.default.provider).toBe("anthropic");
    expect(normalized.overrides.report?.provider).toBe("openai");
    expect(resolveProviderConfig(normalized, "report").model).toBe("gpt-5-mini-2025-08-07");
  });

  it("supports setting and clearing a role override", () => {
    const withOverride = setRoleProviderSelection(fallback, "report", {
      provider: "moonshot",
      model: "kimi-k2-thinking",
    });

    expect(resolveProviderConfig(withOverride, "report").provider).toBe("moonshot");
    expect(resolveProviderConfig(withOverride, "analysis").provider).toBe("anthropic");

    const cleared = clearRoleProviderOverride(withOverride, "report");
    expect(resolveProviderConfig(cleared, "report").provider).toBe("anthropic");
  });

  it("replaces the default selection and clears overrides on global switch", () => {
    const withOverride = setRoleProviderSelection(fallback, "report", {
      provider: "openai",
      model: "gpt-5-mini",
    });
    const switched = setGlobalProviderSelection(withOverride, "openai", "gpt-5.4");

    expect(switched.default.provider).toBe("openai");
    expect(Object.keys(switched.overrides)).toHaveLength(0);
    expect(resolveProviderConfig(switched, "simulation").model).toBe("gpt-5.4-2026-03-05");
  });
});
