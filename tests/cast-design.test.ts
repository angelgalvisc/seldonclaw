import { describe, expect, it } from "vitest";
import { designCast, type CastDesignInput } from "../src/cast-design.js";
import type { LLMClient } from "../src/llm.js";

function mockLlm(response: Record<string, unknown>): LLMClient {
  return {
    completeJSON: async () => ({ data: response, raw: JSON.stringify(response) }),
    complete: async () => ({ text: "", raw: "" }),
    chat: async () => ({ text: "", raw: "" }),
  } as unknown as LLMClient;
}

function failingLlm(): LLMClient {
  return {
    completeJSON: async () => { throw new Error("API error"); },
    complete: async () => { throw new Error("API error"); },
    chat: async () => { throw new Error("API error"); },
  } as unknown as LLMClient;
}

const baseInput: CastDesignInput = {
  spec: {
    title: "CRM disruption after NeMoCLAW",
    objective: "Observe buy-side vs sell-side sentiment convergence",
    hypothesis: "Buy-side reacts to disruption, sell-side frames as validation",
    focusActors: ["CNBC", "macro traders"],
  },
  sourceDocSummaries: [
    "NVIDIA announces NemoClaw, an open-source AI agent platform...",
    "Salesforce reports strong Agentforce adoption in Q4 earnings...",
  ],
};

describe("designCast", () => {
  it("produces cast seeds and communities from LLM response", async () => {
    const llm = mockLlm({
      castSeeds: [
        { name: "NVIDIA", type: "organization", role: "AI platform vendor", stance: "supportive" },
        { name: "Buy-side Macro Analyst", type: "person", role: "buy-side macro analyst", stance: "opposing", community: "Buy-side camp" },
        { name: "Sell-side CRM Analyst", type: "person", role: "sell-side CRM analyst", stance: "supportive", community: "Sell-side camp" },
      ],
      communityProposals: [
        { name: "Buy-side camp", description: "Skeptics on CRM durability", memberLabels: ["Buy-side Macro Analyst", "macro traders"] },
        { name: "Sell-side camp", description: "Incumbent validators", memberLabels: ["Sell-side CRM Analyst"] },
      ],
      entityTypeHints: [
        { name: "NVIDIA", type: "organization" },
        { name: "Salesforce", type: "organization" },
        { name: "TechCrunch", type: "media" },
      ],
    });

    const result = await designCast(llm, baseInput);

    expect(result.castSeeds.length).toBeGreaterThanOrEqual(3);
    expect(result.communityProposals).toHaveLength(2);
    expect(result.entityTypeHints).toHaveLength(3);

    // focusActors should be merged in
    const names = result.castSeeds.map((s) => s.name.toLowerCase());
    expect(names).toContain("cnbc");
    expect(names).toContain("macro traders");

    // Entity type hints
    expect(result.entityTypeHints.find((h) => h.name === "TechCrunch")?.type).toBe("media");
  });

  it("deduplicates cast seeds by name", async () => {
    const llm = mockLlm({
      castSeeds: [
        { name: "NVIDIA", type: "organization", role: "vendor" },
        { name: "nvidia", type: "organization", role: "vendor duplicate" },
      ],
      communityProposals: [],
      entityTypeHints: [],
    });

    const result = await designCast(llm, baseInput);
    const nvidiaSeeds = result.castSeeds.filter((s) => s.name.toLowerCase() === "nvidia");
    expect(nvidiaSeeds).toHaveLength(1);
  });

  it("merges focusActors that are missing from LLM response", async () => {
    const llm = mockLlm({
      castSeeds: [
        { name: "NVIDIA", type: "organization", role: "vendor" },
      ],
      communityProposals: [],
      entityTypeHints: [],
    });

    const result = await designCast(llm, baseInput);
    const names = result.castSeeds.map((s) => s.name.toLowerCase());
    expect(names).toContain("cnbc");
    expect(names).toContain("macro traders");
  });

  it("does not duplicate focusActors already in LLM response", async () => {
    const llm = mockLlm({
      castSeeds: [
        { name: "CNBC", type: "media", role: "business news" },
      ],
      communityProposals: [],
      entityTypeHints: [],
    });

    const result = await designCast(llm, baseInput);
    const cnbcSeeds = result.castSeeds.filter((s) => s.name.toLowerCase() === "cnbc");
    expect(cnbcSeeds).toHaveLength(1);
    expect(cnbcSeeds[0].type).toBe("media");
  });

  it("returns empty cast design on LLM failure", async () => {
    const llm = failingLlm();
    const result = await designCast(llm, baseInput);

    // focusActors still get added even on failure (via normalization fallback path)
    // but the main structure should be empty seeds from LLM
    expect(result.communityProposals).toHaveLength(0);
    expect(result.entityTypeHints).toHaveLength(0);
  });

  it("validates cast seed types and stances", async () => {
    const llm = mockLlm({
      castSeeds: [
        { name: "A", type: "invalid_type", role: "test", stance: "invalid_stance" },
        { name: "B", type: "media", role: "reporter", stance: "observer" },
      ],
      communityProposals: [],
      entityTypeHints: [],
    });

    const result = await designCast(llm, baseInput);
    const seedA = result.castSeeds.find((s) => s.name === "A");
    const seedB = result.castSeeds.find((s) => s.name === "B");

    expect(seedA?.type).toBe("person"); // fallback
    expect(seedA?.stance).toBeUndefined(); // invalid filtered
    expect(seedB?.type).toBe("media");
    expect(seedB?.stance).toBe("observer");
  });

  it("handles empty/null LLM response gracefully", async () => {
    const llm = mockLlm({});
    const result = await designCast(llm, baseInput);

    // Should still have focusActors
    expect(result.castSeeds.length).toBeGreaterThanOrEqual(2);
    expect(result.communityProposals).toHaveLength(0);
    expect(result.entityTypeHints).toHaveLength(0);
  });
});
