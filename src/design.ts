/**
 * design.ts — Natural-language simulation design layer
 *
 * Converts a free-form simulation brief into a typed SimulationSpec,
 * validates the result, and deterministically renders SimConfig + YAML.
 *
 * The LLM is only used to interpret intent. TypeScript remains the source
 * of truth for validation, defaults, and final config rendering.
 */

import YAML from "yaml";
import { defaultConfig, type SimConfig } from "./config.js";
import type { LLMClient } from "./llm.js";

export type SearchTier = "A" | "B";

export interface SimulationSearchSpec {
  enabled: boolean;
  enabledTiers: SearchTier[];
  maxActorsPerRound: number;
  maxActorsByTier: {
    A: number;
    B: number;
  };
  allowArchetypes: string[];
  denyArchetypes: string[];
  allowProfessions: string[];
  denyProfessions: string[];
  allowActors: string[];
  denyActors: string[];
  cutoffDate: string | null;
  categories: string;
  defaultLanguage: string;
  maxResultsPerQuery: number;
  maxQueriesPerActor: number;
  strictCutoff: boolean;
  timeoutMs: number;
}

export interface SimulationFeedSpec {
  embeddingEnabled: boolean;
  embeddingWeight: number;
}

export interface SimulationSpec {
  title: string;
  objective: string;
  hypothesis: string | null;
  docsPath: string | null;
  sourceUrls: string[];
  actorCount: number | null;
  rounds: number;
  focusActors: string[];
  search: SimulationSearchSpec;
  feed: SimulationFeedSpec;
  assumptions: string[];
  warnings: string[];
  castDesign?: CastDesign;
}

// ═══════════════════════════════════════════════════════
// CAST DESIGN — second-pass types for actor/community proposals
// ═══════════════════════════════════════════════════════

/** Actor role seed for simulation — NOT a graph entity. */
export interface CastSeed {
  name: string;
  type: "person" | "organization" | "media" | "institution";
  role: string;
  stance?: string;
  community?: string;
}

/** Community/faction derived from the simulation hypothesis. */
export interface CommunityProposal {
  name: string;
  description: string;
  memberLabels: string[];
}

/** Type hint for graph entity resolution — NOT an actor. */
export interface EntityTypeHint {
  name: string;
  type: string;
}

/** Output of the cast-design pass (produced after source docs are available). */
export interface CastDesign {
  castSeeds: CastSeed[];
  communityProposals: CommunityProposal[];
  entityTypeHints: EntityTypeHint[];
}

// ═══════════════════════════════════════════════════════

export interface DesignValidationIssue {
  field: string;
  message: string;
  severity: "error" | "warning";
}

export interface DesignValidationResult {
  errors: DesignValidationIssue[];
  warnings: DesignValidationIssue[];
}

export interface SimulationDesignResult {
  spec: SimulationSpec;
  validation: DesignValidationResult;
  config: SimConfig;
  yaml: string;
  preview: string;
}

interface SimulationSpecDraft {
  title?: unknown;
  objective?: unknown;
  hypothesis?: unknown;
  docsPath?: unknown;
  sourceUrls?: unknown;
  actorCount?: unknown;
  rounds?: unknown;
  focusActors?: unknown;
  search?: unknown;
  feed?: unknown;
  assumptions?: unknown;
  warnings?: unknown;
}

interface DesignOptions {
  docsPath?: string;
  baseConfig?: SimConfig;
}

const SUPPORTED_ARCHETYPES = new Set(["persona", "organization", "media", "institution"]);
const STRUCTURED_BRIEF_LABELS = new Set([
  "título",
  "titulo",
  "title",
  "objetivo",
  "objective",
  "fuente principal",
  "primary source",
  "source urls",
  "contexto documental",
  "document context",
  "documents path",
  "fecha focal",
  "focal date",
  "tipo de simulación",
  "tipo de simulacion",
  "simulation type",
  "evento inicial",
  "initial event",
  "regla crítica",
  "regla critica",
  "critical rule",
  "actores clave",
  "key actors",
  "configuración",
  "configuracion",
  "configuration",
  "quiero observar",
  "observation targets",
  "quiero como salida",
  "desired outputs",
  "alcance",
  "scope",
  "horizonte temporal",
  "time horizon",
]);

export class DesignValidationError extends Error {
  constructor(public readonly issues: DesignValidationIssue[]) {
    super(
      `Simulation design validation failed:\n${issues
        .map((issue) => `- ${issue.field}: ${issue.message}`)
        .join("\n")}`
    );
    this.name = "DesignValidationError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items: string[] = [];
  for (const item of value) {
    const normalized = normalizeString(item);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(normalized);
  }
  return items.sort((a, b) => a.localeCompare(b));
}

function normalizeTierArray(value: unknown): SearchTier[] {
  if (!Array.isArray(value)) return [];
  const tiers = new Set<SearchTier>();
  for (const item of value) {
    if (item === "A" || item === "B") tiers.add(item);
  }
  return [...tiers].sort();
}

function normalizeBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  return null;
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function normalizeInteger(value: unknown): number | null {
  const normalized = normalizeNumber(value);
  if (normalized === null) return null;
  return Math.round(normalized);
}

function inferDefaultRounds(baseConfig: SimConfig): number {
  return Math.max(
    1,
    Math.round((baseConfig.simulation.totalHours * 60) / baseConfig.simulation.minutesPerRound)
  );
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function capAtLeast(value: number | null, fallback: number, min = 0): number {
  return Math.max(min, value ?? fallback);
}

function normalizeSearchSpec(
  draft: unknown,
  baseConfig: SimConfig,
  assumptions: string[]
): SimulationSearchSpec {
  const base = baseConfig.search;
  const source = isObject(draft) ? draft : {};

  const enabled = normalizeBoolean(source.enabled) ?? false;
  if (enabled && normalizeBoolean(source.enabled) === null) {
    assumptions.push("Enabled web search because the brief requested real-world context.");
  }

  const enabledTiers = normalizeTierArray(source.enabledTiers);
  const maxActorsPerRound = capAtLeast(
    normalizeInteger(source.maxActorsPerRound),
    base.maxActorsPerRound,
    0
  );
  const maxActorsByTierSource = isObject(source.maxActorsByTier) ? source.maxActorsByTier : {};
  const maxActorsByTier = {
    A: capAtLeast(normalizeInteger(maxActorsByTierSource.A), base.maxActorsByTier.A, 0),
    B: capAtLeast(normalizeInteger(maxActorsByTierSource.B), base.maxActorsByTier.B, 0),
  };

  const allowArchetypes = normalizeStringArray(source.allowArchetypes).filter((item) =>
    SUPPORTED_ARCHETYPES.has(item)
  );
  const denyArchetypes = normalizeStringArray(source.denyArchetypes).filter((item) =>
    SUPPORTED_ARCHETYPES.has(item)
  );

  return {
    enabled,
    enabledTiers: enabled
      ? (enabledTiers.length > 0 ? enabledTiers : [...base.enabledTiers])
      : [],
    maxActorsPerRound: enabled ? maxActorsPerRound : 0,
    maxActorsByTier: enabled ? maxActorsByTier : { A: 0, B: 0 },
    allowArchetypes,
    denyArchetypes,
    allowProfessions: normalizeStringArray(source.allowProfessions),
    denyProfessions: normalizeStringArray(source.denyProfessions),
    allowActors: normalizeStringArray(source.allowActors),
    denyActors: normalizeStringArray(source.denyActors),
    cutoffDate: normalizeString(source.cutoffDate) ?? (enabled ? base.cutoffDate : null),
    categories: normalizeString(source.categories) ?? base.categories,
    defaultLanguage: normalizeString(source.defaultLanguage) ?? base.defaultLanguage,
    maxResultsPerQuery: enabled
      ? capAtLeast(normalizeInteger(source.maxResultsPerQuery), base.maxResultsPerQuery, 1)
      : base.maxResultsPerQuery,
    maxQueriesPerActor: enabled
      ? capAtLeast(normalizeInteger(source.maxQueriesPerActor), base.maxQueriesPerActor, 0)
      : base.maxQueriesPerActor,
    strictCutoff: normalizeBoolean(source.strictCutoff) ?? base.strictCutoff,
    timeoutMs: enabled ? capAtLeast(normalizeInteger(source.timeoutMs), base.timeoutMs, 1) : base.timeoutMs,
  };
}

function normalizeFeedSpec(
  draft: unknown,
  baseConfig: SimConfig
): SimulationFeedSpec {
  const base = baseConfig.feed;
  const source = isObject(draft) ? draft : {};

  return {
    embeddingEnabled: normalizeBoolean(source.embeddingEnabled) ?? base.embeddingEnabled,
    embeddingWeight: Math.min(
      1,
      Math.max(0, normalizeNumber(source.embeddingWeight) ?? base.embeddingWeight)
    ),
  };
}

function normalizeSimulationSpec(
  draft: SimulationSpecDraft,
  options: DesignOptions = {}
): SimulationSpec {
  const baseConfig = options.baseConfig ?? defaultConfig();
  const assumptions = normalizeStringArray(draft.assumptions);
  const warnings = normalizeStringArray(draft.warnings);

  const cliDocsPath = normalizeString(options.docsPath);
  const draftDocsPath = normalizeString(draft.docsPath);
  let docsPath = cliDocsPath ?? draftDocsPath;
  if (cliDocsPath && draftDocsPath && cliDocsPath !== draftDocsPath) {
    assumptions.push(`Used CLI documents path (${cliDocsPath}) instead of the brief-provided path.`);
  }

  if (!docsPath) {
    warnings.push(
      "No documents path was specified. A caller must provide source documents or materialize them from the brief before running."
    );
  }

  const objective =
    normalizeString(draft.objective) ??
    "Explore how narratives evolve across actors under the requested scenario.";
  if (normalizeString(draft.objective) === null) {
    assumptions.push("Used a conservative default objective because the brief did not define one explicitly.");
  }

  const title =
    normalizeString(draft.title) ??
    objective.slice(0, 72);

  const rounds = capAtLeast(normalizeInteger(draft.rounds), inferDefaultRounds(baseConfig), 1);
  if (normalizeInteger(draft.rounds) === null) {
    assumptions.push(`Defaulted to ${rounds} rounds based on the current simulation config.`);
  }

  const actorCount = capAtLeast(normalizeInteger(draft.actorCount), 0, 0) || null;
  const sourceUrls = normalizeStringArray(draft.sourceUrls);

  const search = normalizeSearchSpec(draft.search, baseConfig, assumptions);
  const feed = normalizeFeedSpec(draft.feed, baseConfig);

  return {
    title,
    objective,
    hypothesis: normalizeString(draft.hypothesis),
    docsPath,
    sourceUrls,
    actorCount,
    rounds,
    focusActors: normalizeStringArray(draft.focusActors),
    search,
    feed,
    assumptions: Array.from(new Set(assumptions)),
    warnings: Array.from(new Set(warnings)),
  };
}

function parseStructuredSimulationBrief(
  brief: string,
  options: DesignOptions = {}
): SimulationSpecDraft | null {
  const sections = parseLabeledSections(brief);
  const signals = [
    sections.get("título") ?? sections.get("titulo") ?? sections.get("title"),
    sections.get("objetivo") ?? sections.get("objective"),
    sections.get("evento inicial") ?? sections.get("initial event"),
    sections.get("actores clave") ?? sections.get("key actors"),
    sections.get("configuración") ?? sections.get("configuracion") ?? sections.get("configuration"),
  ].filter(Boolean);

  if (signals.length < 3) return null;

  const baseConfig = options.baseConfig ?? defaultConfig();
  const title = cleanStructuredValue(
    firstLine(sections.get("título") ?? sections.get("titulo") ?? sections.get("title"))
  );
  const objective = cleanStructuredValue(sections.get("objetivo") ?? sections.get("objective"));
  const eventInitial = cleanStructuredValue(
    sections.get("evento inicial") ?? sections.get("initial event")
  );
  const criticalRule = cleanStructuredValue(
    sections.get("regla crítica") ?? sections.get("regla critica") ?? sections.get("critical rule")
  );
  const docsPath = cleanStructuredValue(
    sections.get("contexto documental") ??
      sections.get("document context") ??
      sections.get("documents path")
  );
  const dateFocal = normalizeStructuredDate(
    cleanStructuredValue(sections.get("fecha focal") ?? sections.get("focal date"))
  );
  const focusActors = parseBulletList(sections.get("actores clave") ?? sections.get("key actors"));
  const observationTargets = parseBulletList(
    sections.get("quiero observar") ?? sections.get("observation targets")
  );
  const requestedOutputs = parseBulletList(
    sections.get("quiero como salida") ?? sections.get("desired outputs")
  );
  const configurationText = cleanStructuredValue(
    sections.get("configuración") ?? sections.get("configuracion") ?? sections.get("configuration")
  );
  const sourceUrls = extractUrls(
    cleanStructuredValue(
      sections.get("fuente principal") ?? sections.get("primary source") ?? sections.get("source urls")
    ) ?? brief
  );

  const rounds =
    extractRoundsFromConfiguration(configurationText) ??
    extractRoundsFromConfiguration(
      cleanStructuredValue(sections.get("horizonte temporal") ?? sections.get("time horizon"))
    ) ??
    undefined;
  const actorCount = extractActorCountFromConfiguration(configurationText);

  const searchEnabled = /b[uú]squeda web habilitada|internet habilitada|web search enabled/i.test(
    configurationText ?? ""
  );
  const maxActorsPerRound = extractSearchBudget(configurationText);
  const searchAllowProfessions = extractSearchRoles(configurationText);

  const searchDraft = searchEnabled
    ? {
        enabled: true,
        enabledTiers: [...baseConfig.search.enabledTiers],
        maxActorsPerRound: maxActorsPerRound ?? baseConfig.search.maxActorsPerRound,
        maxActorsByTier: splitSearchBudget(
          maxActorsPerRound ?? baseConfig.search.maxActorsPerRound
        ),
        allowArchetypes: [],
        denyArchetypes: [],
        allowProfessions: searchAllowProfessions,
        denyProfessions: [],
        allowActors: [],
        denyActors: [],
        cutoffDate: dateFocal ?? baseConfig.search.cutoffDate,
        categories: baseConfig.search.categories,
        defaultLanguage: inferLanguageFromBrief(brief, baseConfig.search.defaultLanguage),
        maxResultsPerQuery: baseConfig.search.maxResultsPerQuery,
        maxQueriesPerActor: baseConfig.search.maxQueriesPerActor,
        strictCutoff: true,
        timeoutMs: baseConfig.search.timeoutMs,
      }
    : {
        enabled: false,
        enabledTiers: [],
        maxActorsPerRound: 0,
        maxActorsByTier: { A: 0, B: 0 },
        allowArchetypes: [],
        denyArchetypes: [],
        allowProfessions: [],
        denyProfessions: [],
        allowActors: [],
        denyActors: [],
        cutoffDate: dateFocal,
        categories: baseConfig.search.categories,
        defaultLanguage: inferLanguageFromBrief(brief, baseConfig.search.defaultLanguage),
        maxResultsPerQuery: baseConfig.search.maxResultsPerQuery,
        maxQueriesPerActor: baseConfig.search.maxQueriesPerActor,
        strictCutoff: baseConfig.search.strictCutoff,
        timeoutMs: baseConfig.search.timeoutMs,
      };

  const assumptions = [
    "Used the operator's structured brief as the authoritative simulation design source.",
  ];
  if (criticalRule) assumptions.push(`Critical rule: ${criticalRule}`);
  if (eventInitial) assumptions.push(`Initial event: ${eventInitial}`);
  if (requestedOutputs.length > 0) {
    assumptions.push(`Expected outputs: ${requestedOutputs.join(", ")}`);
  }

  return {
    title: title ?? undefined,
    objective: objective ?? undefined,
    hypothesis: eventInitial ?? undefined,
    docsPath: docsPath ?? undefined,
    sourceUrls,
    actorCount,
    rounds,
    focusActors,
    search: searchDraft,
    feed: {
      embeddingEnabled: baseConfig.feed.embeddingEnabled,
      embeddingWeight: baseConfig.feed.embeddingWeight,
    },
    assumptions,
    warnings: observationTargets.length > 0 ? [] : ["The brief did not specify observation targets explicitly."],
  };
}

export function validateSimulationSpec(spec: SimulationSpec): DesignValidationResult {
  const errors: DesignValidationIssue[] = [];
  const warnings: DesignValidationIssue[] = [];

  if (spec.title.trim().length === 0) {
    errors.push({ field: "title", message: "title must not be empty", severity: "error" });
  }

  if (spec.objective.trim().length === 0) {
    errors.push({ field: "objective", message: "objective must not be empty", severity: "error" });
  }

  if (spec.rounds < 1) {
    errors.push({ field: "rounds", message: "rounds must be >= 1", severity: "error" });
  }

  if (spec.search.enabled) {
    if (spec.search.enabledTiers.length === 0) {
      errors.push({
        field: "search.enabledTiers",
        message: "at least one search-enabled tier is required when search is enabled",
        severity: "error",
      });
    }

    if (spec.search.cutoffDate && !isIsoDate(spec.search.cutoffDate)) {
      errors.push({
        field: "search.cutoffDate",
        message: "cutoffDate must be in YYYY-MM-DD format",
        severity: "error",
      });
    }

    const tierBudget = spec.search.maxActorsByTier.A + spec.search.maxActorsByTier.B;
    if (tierBudget < spec.search.maxActorsPerRound) {
      warnings.push({
        field: "search.maxActorsByTier",
        message: "tier budgets are lower than maxActorsPerRound, so the total search budget will be underused",
        severity: "warning",
      });
    }

    if (spec.search.maxQueriesPerActor === 0) {
      warnings.push({
        field: "search.maxQueriesPerActor",
        message: "search is enabled but actors are allowed zero queries per round",
        severity: "warning",
      });
    }
  }

  if (!spec.docsPath) {
    warnings.push({
      field: "docsPath",
      message:
        "documents path is missing; a caller must provide source documents or materialize them from the brief before running",
      severity: "warning",
    });
  }

  if (spec.feed.embeddingEnabled && spec.feed.embeddingWeight <= 0) {
    warnings.push({
      field: "feed.embeddingWeight",
      message: "embedding-aware feed is enabled with zero weight, so it will not affect ranking",
      severity: "warning",
    });
  }

  return { errors, warnings };
}

export function renderSimulationConfig(
  spec: SimulationSpec,
  baseConfig: SimConfig = defaultConfig()
): SimConfig {
  const config = structuredClone(baseConfig);
  config.simulation.totalHours =
    (spec.rounds * config.simulation.minutesPerRound) / 60;

  config.search.enabled = spec.search.enabled;
  config.search.enabledTiers = [...spec.search.enabledTiers];
  config.search.maxActorsPerRound = spec.search.maxActorsPerRound;
  config.search.maxActorsByTier = { ...spec.search.maxActorsByTier };
  config.search.allowArchetypes = [...spec.search.allowArchetypes];
  config.search.denyArchetypes = [...spec.search.denyArchetypes];
  config.search.allowProfessions = [...spec.search.allowProfessions];
  config.search.denyProfessions = [...spec.search.denyProfessions];
  config.search.allowActors = [...spec.search.allowActors];
  config.search.denyActors = [...spec.search.denyActors];
  config.search.cutoffDate = spec.search.cutoffDate ?? baseConfig.search.cutoffDate;
  config.search.categories = spec.search.categories;
  config.search.defaultLanguage = spec.search.defaultLanguage;
  config.search.maxResultsPerQuery = spec.search.maxResultsPerQuery;
  config.search.maxQueriesPerActor = spec.search.maxQueriesPerActor;
  config.search.strictCutoff = spec.search.strictCutoff;
  config.search.timeoutMs = spec.search.timeoutMs;

  config.feed.embeddingEnabled = spec.feed.embeddingEnabled;
  config.feed.embeddingWeight = spec.feed.embeddingWeight;

  return config;
}

export function renderSimulationConfigYaml(
  spec: SimulationSpec,
  baseConfig: SimConfig = defaultConfig()
): string {
  return YAML.stringify(renderSimulationConfig(spec, baseConfig));
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

function parseLabeledSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  let currentLabel: string | null = null;
  const buffer: string[] = [];

  const flush = (): void => {
    if (!currentLabel) return;
    sections.set(currentLabel, buffer.join("\n").trim());
    buffer.length = 0;
  };

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-zÁÉÍÓÚáéíóúÑñ ]+)\s*:\s*(.*)$/);
    if (match) {
      const label = normalizeLabel(match[1]);
      if (STRUCTURED_BRIEF_LABELS.has(label)) {
        flush();
        currentLabel = label;
        if (match[2]?.trim()) buffer.push(match[2].trim());
        continue;
      }
    }
    if (currentLabel) {
      buffer.push(line);
    }
  }

  flush();
  return sections;
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

function firstLine(value: string | undefined): string | null {
  if (!value) return null;
  const line = value.split(/\r?\n/).find((entry) => entry.trim().length > 0);
  return line ? line.trim() : null;
}

function cleanStructuredValue(value: string | undefined | null): string | null {
  if (!value) return null;
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*>\s?/, "").trimEnd())
    .join("\n")
    .trim();
}

function parseBulletList(value: string | undefined | null): string[] {
  if (!value) return [];
  const items = value
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean);
  return Array.from(new Set(items));
}

function extractRoundsFromConfiguration(value: string | null): number | undefined {
  if (!value) return undefined;
  const match = value.match(/(\d+)\s*(?:rounds?|rondas?)/i);
  if (!match) return undefined;
  const rounds = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(rounds) ? rounds : undefined;
}

function extractActorCountFromConfiguration(value: string | null): number | undefined {
  if (!value) return undefined;
  const match = value.match(/(\d+)\s*(?:actors?|agentes?)/i);
  if (!match) return undefined;
  const actorCount = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(actorCount) ? actorCount : undefined;
}

function extractSearchBudget(value: string | null): number | undefined {
  if (!value) return undefined;
  const match =
    value.match(/m[aá]ximo\s+(\d+)\s+actores?\s+por\s+ronda\s+con\s+b[uú]squeda/i) ??
    value.match(/up\s+to\s+(\d+)\s+actors?\s+per\s+round\s+with\s+search/i);
  if (!match) return undefined;
  const budget = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(budget) ? budget : undefined;
}

function extractSearchRoles(value: string | null): string[] {
  if (!value) return [];
  const line = value
    .split(/\r?\n/)
    .find((entry) => /permitir\s+b[uú]squeda\s+a|allow\s+search\s+for/i.test(entry));
  if (!line) return [];
  const stripped = line
    .replace(/^.*permitir\s+b[uú]squeda\s+a\s*/i, "")
    .replace(/^.*allow\s+search\s+for\s*/i, "")
    .trim();
  return stripped
    .split(/,|\sy\s|\sand\s/gi)
    .map((entry) => entry.trim().replace(/\.$/, ""))
    .filter(Boolean);
}

function splitSearchBudget(total: number): { A: number; B: number } {
  const safe = Math.max(1, total);
  const a = Math.ceil(safe / 2);
  const b = Math.max(0, safe - a);
  return { A: a, B: b };
}

function normalizeStructuredDate(value: string | null): string | null {
  if (!value) return null;
  const iso = value.match(/\b\d{4}-\d{2}-\d{2}\b/);
  return iso ? iso[0] : null;
}

function extractUrls(value: string): string[] {
  return Array.from(
    new Set(
      [...value.matchAll(/https?:\/\/\S+/g)]
        .map((match) => match[0].replace(/[),.;]+$/, ""))
        .filter(Boolean)
    )
  );
}

function inferLanguageFromBrief(brief: string, fallback: string): string {
  return /[áéíóúñ]|b[uú]squeda|simulaci[oó]n|mercado/i.test(brief) ? "es" : fallback;
}

export function formatSimulationPlan(
  spec: SimulationSpec,
  validation: DesignValidationResult = validateSimulationSpec(spec)
): string {
  const lines = [
    "Simulation Plan",
    `- Title: ${spec.title}`,
    `- Objective: ${spec.objective}`,
    `- Actor count: ${spec.actorCount ?? "not constrained"}`,
    `- Rounds: ${spec.rounds}`,
    `- Documents: ${spec.docsPath ?? "(provide via --docs when running)"}`,
    `- Source URLs: ${formatList(spec.sourceUrls)}`,
    `- Focus actors: ${formatList(spec.focusActors)}`,
    `- Hypothesis: ${spec.hypothesis ?? "none"}`,
    `- Web search: ${spec.search.enabled ? "enabled" : "disabled"}`,
  ];

  if (spec.search.enabled) {
    lines.push(
      `- Search policy: tiers ${spec.search.enabledTiers.join(", ")}, up to ${spec.search.maxActorsPerRound} actors/round (A:${spec.search.maxActorsByTier.A}, B:${spec.search.maxActorsByTier.B})`
    );
    lines.push(
      `- Search targeting: archetypes ${formatList(spec.search.allowArchetypes)}, professions ${formatList(spec.search.allowProfessions)}, actors ${formatList(spec.search.allowActors)}`
    );
    lines.push(`- Search cutoff: ${spec.search.cutoffDate ?? "none"}`);
  }

  lines.push(
    `- Embedding-aware feed: ${spec.feed.embeddingEnabled ? `enabled (weight ${spec.feed.embeddingWeight})` : "disabled"}`
  );

  if (spec.assumptions.length > 0) {
    lines.push("", "Assumptions:");
    for (const assumption of spec.assumptions) {
      lines.push(`- ${assumption}`);
    }
  }

  const allWarnings = [
    ...spec.warnings,
    ...validation.warnings.map((warning) => `${warning.field}: ${warning.message}`),
  ];
  if (allWarnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of Array.from(new Set(allWarnings))) {
      lines.push(`- ${warning}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function interpretSimulationBrief(
  llm: LLMClient,
  brief: string,
  options: DesignOptions = {}
): Promise<SimulationSpec> {
  const structuredDraft = parseStructuredSimulationBrief(brief, options);
  if (structuredDraft) {
    return normalizeSimulationSpec(structuredDraft, options);
  }

  const baseConfig = options.baseConfig ?? defaultConfig();
  const docsHint = normalizeString(options.docsPath);
  const prompt = [
    "Interpret the following simulation brief and return a structured JSON plan.",
    "",
    `Simulation brief:\n${brief.trim()}`,
    "",
    docsHint ? `Explicit documents path from CLI: ${docsHint}` : "Explicit documents path from CLI: none",
  ].join("\n");

  const system = [
    "You convert user intent into a structured simulation design for a social simulation engine.",
    "Prefer global, generic framing unless the user explicitly requests a region.",
    "Do not invent unsupported platforms or implementation details.",
    'Supported archetypes are: "persona", "organization", "media", "institution".',
    "If the user says only certain roles may search, map concrete jobs like journalist or analyst to allowProfessions, and institutional categories to allowArchetypes.",
    "If information is missing, leave it null when possible and describe the assumption in assumptions.",
    "Return an object with keys: title, objective, hypothesis, docsPath, sourceUrls, actorCount, rounds, focusActors, search, feed, assumptions, warnings.",
    "search must be an object with keys: enabled, enabledTiers, maxActorsPerRound, maxActorsByTier, allowArchetypes, denyArchetypes, allowProfessions, denyProfessions, allowActors, denyActors, cutoffDate, categories, defaultLanguage, maxResultsPerQuery, maxQueriesPerActor, strictCutoff, timeoutMs.",
    "feed must be an object with keys: embeddingEnabled, embeddingWeight.",
    `Current engine defaults: ${JSON.stringify({
      defaultRounds: inferDefaultRounds(baseConfig),
      defaultSearchEnabled: baseConfig.search.enabled,
      defaultSearchTiers: baseConfig.search.enabledTiers,
      defaultSearchBudget: baseConfig.search.maxActorsPerRound,
      defaultActorCount: null,
      defaultFeedEmbeddingEnabled: baseConfig.feed.embeddingEnabled,
    })}`,
  ].join("\n");

  const { data } = await llm.completeJSON<SimulationSpecDraft>("generation", prompt, {
    system,
    temperature: 0.0,
    maxTokens: 1800,
  });

  return normalizeSimulationSpec(data ?? {}, options);
}

export async function designSimulationFromBrief(
  llm: LLMClient,
  brief: string,
  options: DesignOptions = {}
): Promise<SimulationDesignResult> {
  const baseConfig = options.baseConfig ?? defaultConfig();
  const spec = await interpretSimulationBrief(llm, brief, options);
  const validation = validateSimulationSpec(spec);
  if (validation.errors.length > 0) {
    throw new DesignValidationError(validation.errors);
  }

  const config = renderSimulationConfig(spec, baseConfig);
  const yaml = renderSimulationConfigYaml(spec, baseConfig);
  const preview = formatSimulationPlan(spec, validation);

  return {
    spec,
    validation,
    config,
    yaml,
    preview,
  };
}
