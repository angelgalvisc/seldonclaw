# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Please report security vulnerabilities by emailing **security@datastrat.co** with:

1. A description of the vulnerability
2. Steps to reproduce
3. Potential impact
4. Suggested fix (if any)

You will receive a response within 72 hours. We will work with you to understand and address the issue before any public disclosure.

## Security Design Principles

SeldonClaw follows these security principles by design:

### Secrets Never in Persistent Data
- API keys are referenced by environment variable name, never stored as values
- `config.ts sanitizeForStorage()` redacts all secrets before writing to `run_manifest.config_snapshot`
- `telemetry.ts sanitizeDetail()` strips secrets from telemetry action detail
- `ckp.ts scrubSecrets()` removes secrets from export bundles
- Pairing tokens are held in memory only, never written to SQLite

### NullClaw Gateway Security
- Pairing is **enabled by default** (`pairing.enabled: true`)
- Tokens are auto-generated if empty and never logged
- Disable pairing only for confirmed loopback-only deployments (127.0.0.1)
- See `DEPLOYMENT.md` for network topology guidance

### Input Validation
- Config validation rejects invalid ranges before any processing
- Document ingestion uses content hashes (SHA-256) for dedup
- Entity resolution is auditable via `entity_merges` table

### Isolation
- Each simulation run is scoped by `run_id` — queries never mix runs
- The knowledge graph is immutable during simulation (built before, not modified during)
- `RecordedBackend` replays cached decisions without network calls
