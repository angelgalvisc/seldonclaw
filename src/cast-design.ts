/**
 * cast-design.ts — LLM-guided cast & community design for social simulations
 *
 * This is the second pass of the design layer. It runs AFTER source documents
 * have been downloaded and produces:
 *   - castSeeds: actor roles/entities for the simulation
 *   - communityProposals: factions derived from the hypothesis
 *   - entityTypeHints: type corrections for graph entity resolution
 *
 * The brief (instruction role) feeds this layer.
 * Source docs (source role) provide grounding context.
 * Neither contaminates the other's domain.
 */

import type { LLMClient } from "./llm.js";
import type { CastDesign, CastSeed, CommunityProposal, EntityTypeHint, SimulationSpec } from "./design.js";

// ═══════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════

export interface CastDesignInput {
  spec: Pick<SimulationSpec, "title" | "objective" | "hypothesis" | "focusActors">;
  /** First ~500 chars of each downloaded source document */
  sourceDocSummaries: string[];
}

interface CastDesignDraft {
  castSeeds?: unknown;
  communityProposals?: unknown;
  entityTypeHints?: unknown;
}

// ═══════════════════════════════════════════════════════
// PROMPTS
// ═══════════════════════════════════════════════════════

const CAST_DESIGN_SYSTEM = [
  "You are designing the cast of actors and community structure for a social media simulation.",
  "You will receive a simulation objective, hypothesis, user-requested focus actors, and summaries of real source documents.",
  "",
  "Your job is to propose:",
  "1. castSeeds: actors that should participate in this simulation. Each must be a concrete, simulable entity — a real person, company, institution, media outlet, or a named role (e.g., 'buy-side macro analyst'). Do NOT create actors from abstract concepts, headlines, section titles, metadata, or document chunks.",
  '2. communityProposals: distinct factions or camps relevant to the hypothesis. Each has a name, description, and memberLabels referencing castSeed names or focusActor labels.',
  "3. entityTypeHints: for key real-world entities mentioned in the source documents, provide their correct type (person, organization, media, institution).",
  "",
  "Rules:",
  "- castSeeds should cover the diversity needed by the hypothesis (e.g., both sides of a debate).",
  "- Each castSeed type must be one of: person, organization, media, institution.",
  "- Each castSeed stance must be one of: supportive, opposing, neutral, observer.",
  "- communityProposals should reflect the natural social cleavages of the problem.",
  "- entityTypeHints help the knowledge graph assign correct types; only include well-known entities.",
  "- Prefer quality over quantity. 8-15 castSeeds is typical.",
  "",
  "Output valid JSON only. No markdown code fences.",
].join("\n");

// ═══════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════

/**
 * Design the simulation cast and community structure using LLM.
 * Runs after source docs have been downloaded.
 */
export async function designCast(
  llm: LLMClient,
  input: CastDesignInput
): Promise<CastDesign> {
  const { spec, sourceDocSummaries } = input;

  const docContext = sourceDocSummaries.length > 0
    ? sourceDocSummaries.map((s, i) => `Source ${i + 1}:\n${s}`).join("\n\n")
    : "No source documents available.";

  const prompt = [
    `Simulation: ${spec.title}`,
    "",
    `Objective: ${spec.objective}`,
    "",
    `Hypothesis: ${spec.hypothesis ?? "Not specified."}`,
    "",
    `User-requested focus actors: ${spec.focusActors.length > 0 ? spec.focusActors.join(", ") : "None specified."}`,
    "",
    "Source document summaries:",
    docContext,
    "",
    "Return a JSON object with keys: castSeeds, communityProposals, entityTypeHints.",
    'castSeeds: array of {name, type, role, stance, community}',
    'communityProposals: array of {name, description, memberLabels}',
    'entityTypeHints: array of {name, type}',
  ].join("\n");

  try {
    const { data } = await llm.completeJSON<CastDesignDraft>("generation", prompt, {
      system: CAST_DESIGN_SYSTEM,
      temperature: 0.1,
      maxTokens: 2500,
    });

    return normalizeCastDesign(data ?? {}, spec.focusActors);
  } catch {
    return emptyCastDesign();
  }
}

// ═══════════════════════════════════════════════════════
// NORMALIZATION
// ═══════════════════════════════════════════════════════

function emptyCastDesign(): CastDesign {
  return { castSeeds: [], communityProposals: [], entityTypeHints: [] };
}

const VALID_SEED_TYPES = new Set(["person", "organization", "media", "institution"]);
const VALID_STANCES = new Set(["supportive", "opposing", "neutral", "observer"]);

function normalizeCastDesign(draft: CastDesignDraft, focusActors: string[]): CastDesign {
  const castSeeds = normalizeCastSeeds(draft.castSeeds);
  const communityProposals = normalizeCommunityProposals(draft.communityProposals);
  const entityTypeHints = normalizeEntityTypeHints(draft.entityTypeHints);

  // Ensure focusActors appear as castSeeds if not already present
  const seedNames = new Set(castSeeds.map((s) => s.name.toLowerCase().trim()));
  for (const fa of focusActors) {
    const normalized = fa.toLowerCase().trim();
    if (normalized && !seedNames.has(normalized)) {
      castSeeds.push({
        name: fa.trim(),
        type: "person",
        role: fa.trim(),
      });
      seedNames.add(normalized);
    }
  }

  return { castSeeds, communityProposals, entityTypeHints };
}

function normalizeCastSeeds(raw: unknown): CastSeed[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: CastSeed[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const rawType = typeof obj.type === "string" ? obj.type.trim().toLowerCase() : "";
    const type = VALID_SEED_TYPES.has(rawType)
      ? (rawType as CastSeed["type"])
      : "person";

    const rawStance = typeof obj.stance === "string" ? obj.stance.trim().toLowerCase() : undefined;
    const stance = rawStance && VALID_STANCES.has(rawStance) ? rawStance : undefined;

    result.push({
      name,
      type,
      role: typeof obj.role === "string" ? obj.role.trim() : name,
      stance,
      community: typeof obj.community === "string" ? obj.community.trim() : undefined,
    });
  }
  return result;
}

function normalizeCommunityProposals(raw: unknown): CommunityProposal[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: CommunityProposal[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const description = typeof obj.description === "string" ? obj.description.trim() : "";
    const memberLabels = Array.isArray(obj.memberLabels)
      ? [...new Set(
          obj.memberLabels
            .filter((label): label is string => typeof label === "string")
            .map((label) => label.trim())
            .filter(Boolean)
        )]
      : [];

    result.push({ name, description, memberLabels });
  }
  return result;
}

function normalizeEntityTypeHints(raw: unknown): EntityTypeHint[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const result: EntityTypeHint[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    const type = typeof obj.type === "string" ? obj.type.trim().toLowerCase() : "";
    if (!name || !type) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ name, type });
  }
  return result;
}
