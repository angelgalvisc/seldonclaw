# SeldonClaw — Deployment & Operational Security Guide

This document covers deployment topology, network security, secrets management, container hardening, and observability. It complements `PLAN.md` (architecture & code) without duplicating it.

## Deployment Topologies

### Development (local)

```
┌─────────────────────────────────────┐
│           localhost                  │
│                                     │
│  seldonclaw ──127.0.0.1:3000──▶ nullclaw  │
│       │                             │
│  simulation.db    output/           │
└─────────────────────────────────────┘
```

- 2 processes, same machine
- NullClaw bound to `127.0.0.1` only
- Pairing: optional (can disable for pure loopback)
- API keys via env vars (`export ANTHROPIC_API_KEY=...`)
- No containers required

### Production / Demo

```
┌──────────────────────────────────────────┐
│          Private network (bridge)         │
│                                          │
│  ┌──────────────┐    ┌───────────────┐   │
│  │ seldonclaw   │───▶│  nullclaw     │   │
│  │ container    │    │  container    │   │
│  │              │    │  port 3000    │   │
│  │ vol: db,out  │    │  internal     │   │
│  └──────────────┘    └───────────────┘   │
│                                          │
│  No ports exposed to host or Internet    │
└──────────────────────────────────────────┘
```

- 2 separate containers, private Docker network
- NullClaw: **never** exposed to the Internet
- Pairing: **mandatory** (active by default in config)
- Secrets: external secret store or Docker secrets
- Minimal port exposure

## Network Security

### Binding

| Environment | NullClaw bind address | Rationale |
|---|---|---|
| Local dev | `127.0.0.1:3000` | Loopback only, no external access |
| Docker | Container-internal port `3000` | Docker network isolates; never publish to `0.0.0.0` |
| Remote/cloud | Behind internal proxy | Proxy handles TLS, auth; NullClaw never directly reachable |

### Docker Port Publishing

**Correct:**
```bash
docker run -p 127.0.0.1:3000:3000 nullclaw
```

**Wrong (exposes to all interfaces):**
```bash
docker run -p 3000:3000 nullclaw          # DO NOT do this
docker run -p 0.0.0.0:3000:3000 nullclaw  # DO NOT do this
```

### Rules

1. NullClaw is an internal service. It should never be a public endpoint.
2. If remote deployment is needed, place NullClaw behind an internal reverse proxy (nginx, Caddy, Traefik) — do not expose it directly.
3. All SeldonClaw → NullClaw traffic should stay on loopback or a private Docker network.

## Authentication

### Pairing

The plan's config defaults to `pairing.enabled: true` (secure by default).

| Scenario | Pairing | Rationale |
|---|---|---|
| Local dev, confirmed `127.0.0.1` | Can disable | Loopback-only, no external risk |
| Docker compose, private network | **Required** | Container networking can be misconfigured |
| Any remote or cloud deployment | **Required** | Network boundaries are not guaranteed |

### Bearer Token Handling

The pairing token is a **session secret**. It must:

- Live in memory only during the process lifetime
- **Never** be written to `run_manifest.config_snapshot`
- **Never** appear in `telemetry.action_detail`
- **Never** be logged to stdout, stderr, or log files
- **Never** be included in export bundles

`config.ts` provides `sanitizeForStorage()` which strips all secrets before serializing to `config_snapshot`. This function removes:
- `pairing.token`
- `providers.*.apiKeyEnv` values (keeps the env var name, not the resolved value)
- Any field matching known secret patterns

### Auth Header Flow

When pairing is active, every `NullClawBackend` request to `/a2a` or `/webhook` must include the `Authorization: Bearer <token>` header. The `authHeaders()` method in `nullclaw-worker.ts` handles this transparently.

## Secrets Management

### Rules

1. API keys are **only** provided via environment variables or a secret store.
2. The following locations must **never** contain actual secret values:
   - `seldonclaw.config.yaml` (only env var names like `"ANTHROPIC_API_KEY"`)
   - `claw.yaml` templates or exports (only `secret_ref` references)
   - `run_manifest.config_snapshot` (sanitized by `config.ts`)
   - `decision_cache.raw_response` (redacted by `reproducibility.ts`)
   - `telemetry.action_detail` (redacted by `telemetry.ts`)
   - Export bundles (`ckp.ts` runs `scrubSecrets()` before writing)
   - Snapshots
   - Log files

3. `ckp.ts` export-agent pipeline runs `scrubSecrets()` which:
   - Strips any field value matching API key patterns (`sk-...`, `key-...`, bearer tokens)
   - Preserves `secret_ref` references (the name, not the value)
   - Scans all JSON fields recursively for leaked secrets
   - Fails the export if a potential secret is detected and `--force` is not set

### Environment Variable Convention

```bash
# Required
export ANTHROPIC_API_KEY="sk-ant-..."

# Optional (NullClaw configuration)
export NULLCLAW_PORT=3000
export NULLCLAW_PAIRING_TOKEN="..."   # auto-generated if not set
```

## Container Hardening

### Image Design

- **2 separate containers** — do not combine into one "for simplicity"
- Base images: minimal (e.g., `node:22-slim` for seldonclaw, binary-only for nullclaw)
- Run as **non-root** user
- Use Docker rootless mode on Linux when possible

### Read-Only Root Filesystem

```yaml
# docker-compose.yml example
services:
  seldonclaw:
    image: seldonclaw:latest
    read_only: true
    user: "1000:1000"
    tmpfs:
      - /tmp
    volumes:
      - ./data/simulation.db:/app/simulation.db
      - ./data/output:/app/output
      - ./docs:/app/docs:ro          # input documents: read-only
    environment:
      - ANTHROPIC_API_KEY
    deploy:
      resources:
        limits:
          cpus: "2.0"
          memory: 512M

  nullclaw:
    image: nullclaw:latest
    read_only: true
    user: "1000:1000"
    tmpfs:
      - /tmp
    networks:
      - internal
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 256M

networks:
  internal:
    driver: bridge
    internal: true                   # no external connectivity
```

### Volume Policy

| Mount | Container | Access | Purpose |
|---|---|---|---|
| `simulation.db` | seldonclaw | read-write | Primary data store |
| `output/` | seldonclaw | read-write | Report output |
| `docs/` (input) | seldonclaw | **read-only** | Source documents for ingestion |
| `/tmp` | both | tmpfs | Ephemeral temp files only |

**Do not mount** the entire workspace, home directory, or host filesystem into any container.

### Resource Limits

Set CPU and memory limits per container to prevent a runaway LLM call loop from consuming all host resources. Suggested starting points:

| Container | CPU | Memory | Rationale |
|---|---|---|---|
| seldonclaw | 2 cores | 512MB | SQLite + Node.js + LLM API calls |
| nullclaw | 1 core | 256MB | Lightweight gateway process (678KB binary) |

Adjust based on actual benchmarks.

## SQLite Security

### File Permissions

```bash
chmod 600 simulation.db              # owner read-write only
chown appuser:appuser simulation.db  # owned by the non-root app user
```

### Backups

- Back up `simulation.db` after every important run completes.
- Use `sqlite3 simulation.db ".backup backup.db"` for safe online backups (respects WAL).
- Version backups by run_id: `simulation-<run_id>.db.bak`
- On shared hosts, encrypt the volume or disk where the database lives.

### WAL Mode Considerations

The schema uses `PRAGMA journal_mode=WAL` for concurrent reads. In Docker:
- The WAL file (`simulation.db-wal`) and shared-memory file (`simulation.db-shm`) must be on the same volume as the main database.
- Do not put the database on a network filesystem (NFS, CIFS) — WAL requires POSIX locking.

## Observability

### What Telemetry Must NOT Store

The `telemetry` table's `action_detail` field is sanitized by `telemetry.ts sanitizeDetail()` before writing. The following must **never** appear in stored telemetry:

- API keys or bearer tokens
- HTTP Authorization headers
- Pairing tokens
- Complete prompts with embedded secrets
- Raw LLM request/response bodies (those go in `decision_cache` with their own redaction)

### Separation of Concerns

| Data type | Storage | Purpose |
|---|---|---|
| Simulation data | `telemetry`, `rounds`, `posts`, etc. in SQLite | Analysis, reports, replay |
| Operational logs | stdout/stderr or log files | Debugging, monitoring |
| Secrets | Environment variables or secret store | Authentication |

These three categories must never mix. Operational logs should not contain simulation data. Simulation data should not contain secrets.

### Redact Mode

For debugging in shared environments, `telemetry.ts` supports a redact mode (`simulation.redactTelemetry: true` in config) that:

- Truncates `action_detail` content fields to first 50 characters
- Replaces actor personality text with `[REDACTED]`
- Strips any field value matching secret patterns
- Preserves all numeric metrics (tokens, cost, duration) unchanged

## Export Bundle Security

### What Gets Scrubbed

`ckp.ts scrubSecrets()` runs before any file is written to the bundle:

| Field | Action |
|---|---|
| `claw.yaml` provider `auth.secret_ref` | Kept (it's a reference name, not a value) |
| Any resolved API key value | **Stripped** |
| Bearer tokens | **Stripped** |
| `config_snapshot` references in metadata | **Sanitized** (same as run_manifest) |
| Pairing tokens | **Stripped** |

### Bundle Versioning

Every export bundle's `manifest.meta.json` includes:

```json
{
  "run_id": "uuid",
  "round_exported": 42,
  "seldonclaw_version": "0.1.0",
  "schema_version": "1",
  "graph_revision_id": "sha256:...",
  "prompt_version": "sha256:...",
  "exported_at": "2026-03-14T12:00:00Z"
}
```

This enables receivers to verify compatibility and provenance without exposing any secrets.

### Portability Disclaimer

Portability means structure + state, **not behavioral equivalence**. An exported actor running on a different CKP runtime will have:
- Same personality, tools, policies, beliefs
- Different LLM (potentially), different context window, different memory backend
- No guarantee of identical behavior

## Quick Reference

### Dev Setup Checklist

- [ ] `export ANTHROPIC_API_KEY=...`
- [ ] NullClaw running on `127.0.0.1:3000`
- [ ] `pairing.enabled: false` only if confirmed loopback
- [ ] `simulation.db` with restrictive permissions
- [ ] Input docs in a separate directory (not mixed with output)

### Prod/Demo Checklist

- [ ] 2 separate containers, private Docker network
- [ ] NullClaw **not** exposed to any public interface
- [ ] `pairing.enabled: true` with auto-generated token
- [ ] API keys via Docker secrets or env vars (never in config files)
- [ ] Read-only root filesystem on both containers
- [ ] Resource limits set (CPU + memory)
- [ ] Input docs mounted read-only
- [ ] Volume only for `simulation.db` and `output/`
- [ ] Running as non-root user
- [ ] Database backups configured

### Cardinal Rules

1. **Never expose NullClaw to the Internet.**
2. **Never disable auth outside of loopback.**
3. **Never mix secrets with exports or telemetry.**
4. **Never put everything in a single container "for simplicity."**
