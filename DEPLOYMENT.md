# PublicMachina — Operations Guide

This document covers the active operational surface of PublicMachina:

- local development runs
- packaged CLI installs
- containerized batch runs
- optional SearXNG integration
- filesystem and secret-handling rules

It complements `README.md` and `PLAN.md`. Historical notes about deferred external runtimes belong in `IMPLEMENTATION_HISTORY.md`, not here.

## Runtime Model

PublicMachina is a CLI-first TypeScript application.

The active runtime is:

- one Node.js process running the CLI
- one SQLite database per environment or experiment
- optional access to a live LLM provider
- optional access to a self-hosted SearXNG instance for web-grounded search

There is no required sidecar gateway in the active product.

## Supported Topologies

### Local Development

Recommended for:

- feature work
- test runs
- mock-mode validation
- manual live checks with a real API key

Layout:

```text
docs/           # source material (read-only in practice)
simulation.db   # SQLite run store
output/         # reports or generated artifacts
```

Command pattern:

```bash
publicmachina run --docs ./docs --db ./simulation.db --run local-smoke
```

### Packaged CLI Install

Recommended for:

- trying the project outside the repo
- validating npm packaging
- lightweight workstation usage

Typical flow:

```bash
npm install
npm run build
node dist/index.js doctor
node dist/index.js run --docs ./docs --db ./simulation.db --mock
```

After publishing, this becomes:

```bash
npx publicmachina doctor
npx publicmachina run --docs ./docs --db ./simulation.db --mock
```

### Containerized Batch Run

Recommended for:

- reproducible demo environments
- scheduled batch runs
- isolated runs on a server or VM

Container policy:

- one container for PublicMachina
- optional separate SearXNG container
- no need for additional runtime services unless you explicitly want them

## Secrets Management

Rules:

1. API keys live in environment variables or an external secret store.
2. Config files should store env var names or non-secret endpoints, not raw credentials.
3. Export bundles must never contain secrets.
4. Reports, telemetry, and persisted config snapshots must stay sanitized.

Protected surfaces already in code:

- `sanitizeForStorage()` in `src/config.ts`
- telemetry sanitization in `src/telemetry.ts`
- CKP bundle scrubbing in `src/ckp.ts`

Recommended environment variables:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

Optional search:

```bash
export SEARXNG_URL="http://localhost:8888"
```

## Filesystem Rules

Treat these paths explicitly:

| Path | Access | Purpose |
|---|---|---|
| `simulation.db` | read-write | primary simulation store |
| `output/` | read-write | reports and generated artifacts |
| `docs/` | read-only by convention | source material for ingestion |
| temporary dirs | ephemeral | smoke tests, exports, build output |

Do not mount or expose an entire home directory into a container just to run PublicMachina.

## Optional SearXNG

PublicMachina can enrich Tier A/B cognition with real web search through SearXNG.

Operational guidance:

- keep SearXNG self-hosted
- prefer a local containerized deployment
- expose it on a trusted local or private-network address
- ensure JSON output is enabled in `search.formats`

Typical local endpoint:

```text
http://localhost:8888
```

Minimal validation flow:

```bash
curl "http://localhost:8888/search?q=product+recall&format=json"
publicmachina doctor --config ./publicmachina.config.yaml
```

## Container Example

This example reflects the active product surface:

```yaml
services:
  publicmachina:
    image: publicmachina:latest
    working_dir: /app
    command: ["node", "dist/index.js", "run", "--docs", "/app/docs", "--db", "/app/simulation.db", "--run", "batch-run"]
    environment:
      - ANTHROPIC_API_KEY
    volumes:
      - ./docs:/app/docs:ro
      - ./data:/app
    read_only: true
    tmpfs:
      - /tmp

  searxng:
    image: searxng/searxng:latest
    ports:
      - "127.0.0.1:8888:8080"
```

Notes:

- `publicmachina` does not need inbound public ports
- SearXNG should stay local/private unless you have a reason to expose it
- mount only what the run needs

## Release Validation

Before calling an environment production-ready, validate:

1. `publicmachina doctor` passes
2. `npm test` passes in the source checkout
3. `npm pack --dry-run` succeeds for publishable builds
4. a real non-`--mock` run succeeds with your configured LLM key
5. if search is enabled, at least one run produces rows in:
   - `search_requests`
   - `search_cache`

## Security Checklist

- [ ] No raw secrets in `publicmachina.config.yaml`
- [ ] No raw secrets in exported CKP bundles
- [ ] `simulation.db` stored with restricted filesystem permissions where appropriate
- [ ] `docs/` mounted or shared read-only in containerized runs
- [ ] optional SearXNG endpoint reachable only where intended
- [ ] no public-facing service exposed unless deliberately added outside PublicMachina itself

## Non-Goals

This document does not describe:

- a mandatory gateway runtime
- an active External runtime deployment path
- historical experimental backends

Those are not part of the active PublicMachina product surface.
