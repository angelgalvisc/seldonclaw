/**
 * db.ts — Barrel re-export
 *
 * Preserves the public API of the original monolithic db.ts.
 * All consumers (src/*.ts, tests/*.ts) import from "./db.js"
 * and continue to work unchanged.
 *
 * Internal modules:
 *   types.ts  — Domain types (rows, snapshots, DTOs)
 *   schema.ts — SCHEMA_SQL DDL constant
 *   store.ts  — GraphStore interface + SQLiteGraphStore
 *   ids.ts    — uuid() + stableId()
 */

export * from "./types.js";
export * from "./schema.js";
export { GraphStore, SQLiteGraphStore } from "./store.js";
export { uuid, stableId } from "./ids.js";
