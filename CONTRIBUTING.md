# Contributing to SeldonClaw

Thank you for your interest in contributing to SeldonClaw.

## Getting Started

```bash
git clone https://github.com/angelgalvisc/seldonclaw.git
cd seldonclaw
npm install
npm test
```

## Development

```bash
npm run dev      # TypeScript watch mode
npm test         # Run tests once
npm run test:watch  # Watch mode
npm run build    # Production build
```

## Architecture

SeldonClaw is a flat `src/` structure (~20 TypeScript files). Read `PLAN.md` for the full architectural specification.

**Key files:**
- `PLAN.md` — Complete architecture, schema, interfaces, and design decisions
- `CLAUDE.md` — Implementation roadmap with phase-by-phase verification
- `DEPLOYMENT.md` — Deployment topologies and operational guidance

## Code Standards

- **TypeScript strict mode** — no `any` types without justification
- **SQLite as source of truth** — in-memory state is always a projection
- **Secrets never in persistent data** — use `sanitizeForStorage()`, `sanitizeDetail()`, `scrubSecrets()`
- **PRNG everywhere** — `round.rng.next()`, never `Math.random()`
- **Run isolation** — every mutable table query includes `run_id`

## Pull Requests

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Write tests for new functionality
4. Ensure all tests pass (`npm test`)
5. Ensure TypeScript compiles cleanly (`npx tsc --noEmit`)
6. Submit a pull request with a clear description

## Reporting Issues

Use GitHub Issues. For security vulnerabilities, see `SECURITY.md`.

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
