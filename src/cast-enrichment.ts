/**
 * cast-enrichment.ts — Source document enrichment + cast quality improvements
 *
 * Phase C1: Extract structured metadata from ingested documents to provide
 * richer grounding for cast design. Each document is summarized with:
 *   - title, source URL, clean summary
 *   - named entities mentioned
 *   - central claims/facts
 *
 * Phase C3: Graph-backed validation for entity types and relationships.
 *
 * Phase C4: Community proposals influence follow graph and stance distributions.
 *
 * Reference: PLAN_PRODUCT_EVOLUTION.md §7.4
 */

import type { GraphStore, DocumentRecord, Entity, Claim } from "./db.js";
import type { EnrichedSourceSummary } from "./cast-design.js";
import type { CommunityProposal } from "./design.js";

// ═══════════════════════════════════════════════════════
// C1: ENRICHED SOURCE SUMMARIES
// ═══════════════════════════════════════════════════════

/**
 * Extract enriched summaries from ingested documents.
 * Uses claims and entities already extracted during the ingest/analyze pipeline.
 *
 * This replaces the flat "first ~500 chars" approach with structured
 * metadata that the cast design LLM can use more effectively.
 */
export function extractEnrichedSources(store: GraphStore): EnrichedSourceSummary[] {
  const documents = store.getAllDocuments();
  if (documents.length === 0) return [];

  const enriched: EnrichedSourceSummary[] = [];

  for (const doc of documents) {
    const chunks = store.getChunksByDocument(doc.id);
    const allClaims: Claim[] = [];
    for (const chunk of chunks) {
      allClaims.push(...store.getClaimsByChunk(chunk.id));
    }

    // Extract named entities from claims
    const entityNames = new Set<string>();
    for (const claim of allClaims) {
      entityNames.add(claim.subject);
      if (claim.object && claim.object.length < 80) {
        entityNames.add(claim.object);
      }
    }

    // Build a clean summary from the first chunk(s)
    const summaryText = chunks
      .slice(0, 2)
      .map((c) => c.content)
      .join(" ")
      .slice(0, 500)
      .trim();

    // Extract the most important claims (by confidence, deduplicated)
    const topClaims = allClaims
      .sort((a, b) => (b.confidence ?? 1) - (a.confidence ?? 1))
      .slice(0, 8)
      .map((c) => `${c.subject} ${c.predicate} ${c.object}`);

    // Parse metadata for URL
    const metadata = parseDocMetadata(doc.metadata);

    enriched.push({
      title: metadata.title ?? doc.filename,
      sourceUrl: metadata.url ?? doc.filename,
      summary: summaryText || `Document: ${doc.filename}`,
      namedEntities: [...entityNames].slice(0, 15),
      centralClaims: topClaims,
    });
  }

  return enriched;
}

// ═══════════════════════════════════════════════════════
// C3: GRAPH-BACKED ENTITY TYPE VALIDATION
// ═══════════════════════════════════════════════════════

/**
 * Validate and correct entity types using graph relationships.
 *
 * Example: an entity with edges to "published_by" media outlets
 * is likely a person (journalist), not an organization.
 */
export function validateEntityTypes(
  store: GraphStore
): Array<{ entityId: string; name: string; currentType: string; suggestedType: string; reason: string }> {
  const entities = store.getAllActiveEntities();
  // Only suggest types that actually exist in the entity_types table to avoid FK violations
  const validTypes = new Set(store.getAllEntityTypeNames());
  const corrections: Array<{
    entityId: string;
    name: string;
    currentType: string;
    suggestedType: string;
    reason: string;
  }> = [];

  for (const entity of entities) {
    const provenance = store.queryProvenance(entity.id);
    const claimPredicates = provenance.claims.map((c) => c.predicate.toLowerCase());

    // Heuristic: entities with "CEO of", "works at", "founded" predicates are persons
    const personSignals = claimPredicates.filter((p) =>
      p.includes("ceo") || p.includes("founder") || p.includes("works at") ||
      p.includes("analyst at") || p.includes("director of") || p.includes("manages")
    ).length;

    // Heuristic: entities with "headquartered", "traded on", "revenue" are organizations
    const orgSignals = claimPredicates.filter((p) =>
      p.includes("headquartered") || p.includes("traded on") || p.includes("revenue") ||
      p.includes("founded in") || p.includes("employs")
    ).length;

    // Heuristic: entities with "publishes", "reported by", "covers" are media
    const mediaSignals = claimPredicates.filter((p) =>
      p.includes("publishes") || p.includes("reported") || p.includes("covers") ||
      p.includes("editorial")
    ).length;

    const suggestedType = inferTypeFromSignals(personSignals, orgSignals, mediaSignals);

    // Only apply correction if the suggested type exists in the DB's entity_types table
    if (suggestedType && suggestedType !== entity.type && validTypes.has(suggestedType)) {
      corrections.push({
        entityId: entity.id,
        name: entity.name,
        currentType: entity.type,
        suggestedType,
        reason: `Claim analysis: person=${personSignals}, org=${orgSignals}, media=${mediaSignals}`,
      });
    }
  }

  return corrections;
}

function inferTypeFromSignals(
  person: number,
  org: number,
  media: number
): string | null {
  const max = Math.max(person, org, media);
  if (max === 0) return null;
  if (max < 2) return null; // Not enough signal

  if (person > org && person > media) return "person";
  if (org > person && org > media) return "organization";
  if (media > person && media > org) return "media";
  return null;
}

// ═══════════════════════════════════════════════════════
// C4: COMMUNITY-INFLUENCED FOLLOW GRAPH
// ═══════════════════════════════════════════════════════

/**
 * Compute follow probability between two actors based on community membership.
 * Actors in the same community are more likely to follow each other.
 * Actors in overlapping communities have moderate follow probability.
 * Cross-community follows are less likely but still possible.
 *
 * This replaces the flat random follow density with community-aware initialization.
 */
export function communityFollowProbability(
  actorCommunityId: string | null,
  targetCommunityId: string | null,
  communityOverlaps: Map<string, Map<string, number>>,
  baseDensity: number = 0.3
): number {
  if (!actorCommunityId || !targetCommunityId) return baseDensity;

  // Same community: higher follow probability
  if (actorCommunityId === targetCommunityId) {
    return Math.min(1.0, baseDensity * 2.0);
  }

  // Overlapping communities: moderate boost
  const overlaps = communityOverlaps.get(actorCommunityId);
  if (overlaps) {
    const weight = overlaps.get(targetCommunityId);
    if (weight !== undefined) {
      return Math.min(1.0, baseDensity * (1.0 + weight));
    }
  }

  // Cross-community: reduced probability
  return baseDensity * 0.5;
}

/**
 * Compute initial stance bias based on community membership.
 * Community proposals include a description that implies a stance direction.
 * This gives actors in the same community correlated (but not identical) stances.
 */
export function communitySentimentBias(
  actorCommunityId: string | null,
  proposals: CommunityProposal[],
  actorSentiment: number
): number {
  if (!actorCommunityId) return actorSentiment;

  const community = proposals.find(
    (p) => p.name.toLowerCase().replace(/\s+/g, "-") === actorCommunityId ||
           p.name.toLowerCase() === actorCommunityId
  );
  if (!community) return actorSentiment;

  // Check if community description implies a stance direction
  const desc = community.description.toLowerCase();
  const supportiveSignals = ["supportive", "bullish", "pro-", "favor", "optimistic", "believe in"];
  const opposingSignals = ["opposing", "bearish", "anti-", "against", "skeptic", "critical"];

  const isSupportive = supportiveSignals.some((s) => desc.includes(s));
  const isOpposing = opposingSignals.some((s) => desc.includes(s));

  if (isSupportive && !isOpposing) {
    // Nudge toward positive sentiment
    return actorSentiment + Math.abs(actorSentiment) * 0.2;
  }
  if (isOpposing && !isSupportive) {
    // Nudge toward negative sentiment
    return actorSentiment - Math.abs(actorSentiment) * 0.2;
  }

  return actorSentiment;
}

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════

function parseDocMetadata(metadata: string | null | undefined): {
  title?: string;
  url?: string;
} {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata);
    return {
      title: typeof parsed.title === "string" ? parsed.title : undefined,
      url: typeof parsed.url === "string" ? parsed.url : undefined,
    };
  } catch {
    return {};
  }
}
