/**
 * ids.ts — ID generation utilities
 *
 * uuid(): random UUID wrapper
 * stableId(...parts): deterministic SHA-256-based UUID-like ID
 */

import { randomUUID, createHash } from "node:crypto";

export function uuid(): string {
  return randomUUID();
}

/**
 * Generate a deterministic UUID-like ID from input parts.
 * Uses SHA-256 truncated to 32 hex chars (128 bits).
 * Formatted as UUID-like: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 *
 * This replaces randomUUID() for structural IDs to ensure reproducibility:
 * same inputs → same IDs → same downstream decisions.
 */
export function stableId(...parts: string[]): string {
  const hash = createHash("sha256").update(parts.join("|")).digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}
