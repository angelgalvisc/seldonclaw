# Plan: Refactor del pipeline de simulación — Cast Design Layer

## Contexto

La simulación CRM/SaaS (NeMoCLAW) expuso 5 problemas concretos en el pipeline.
El commit `0de80f0` ya corrigió los **bugs reales**:
- Brief fragment overwrite
- Brief contaminando el corpus como fuente
- `focusActors` sin peso real en la generación de actores
- Fallos sin mensaje útil

Lo que queda son **gaps de diseño** que requieren un cambio arquitectónico controlado:
1. Seed posts son placeholders — nunca contenido real
2. Entity types se asignan con regex (`guessEntityType`) — no sirve para inglés ni finanzas
3. Comunidades por overlap de topics — no descubre buy-side vs sell-side
4. Contenido repetitivo (consecuencia de 2 y 3)
5. Search no se activa — professions no matchean `allowProfessions`

## Principio de diseño

**No es "pipeline rígido" ni "LLM decide todo".**

Es un **híbrido**: el LLM diseña la estructura social (cast, comunidades, cleavages narrativos) en una capa nueva y explícita. El pipeline determinista la ejecuta y es auditable.

PublicMachina no debe volverse "un prompt gigante con side effects".

## Invariante: document roles

Todo documento que entra al sistema tiene un rol:

| Rol | Entra a | Ejemplo |
|-----|---------|---------|
| `instruction` | Design layer solamente | El brief del operador, la hipótesis |
| `source` | Ontology/graph/grounding | Artículos descargados, datasets |

Solo documentos con rol `source` alimentan el pipeline de ingestión (`ingest.ts` → `ontology.ts` → `graph.ts`).
El brief **nunca** entra al corpus — solo alimenta el diseño y el cast.

Esto ya se corrigió en el commit `0de80f0` (se dejó de materializar `operator-brief.md` dentro de `docs/`), pero queda como invariante arquitectónico para que no se rompa en refactors futuros.

## Arquitectura objetivo: 3 capas

```
┌─────────────────────────────────────────────────────┐
│  DESIGN LAYER (LLM-guided, two-pass)                │
│                                                     │
│  Pass 1: spec design (antes de source docs)         │
│    brief → SimulationSpec                           │
│    Produce: title, objective, hypothesis,           │
│    sourceUrls, focusActors, search, feed            │
│    Archivo: src/design.ts (existente)               │
│                                                     │
│  ── source docs se descargan aquí ──                │
│                                                     │
│  Pass 2: cast design (con source docs disponibles)  │
│    spec + source docs descargados → CastDesign      │
│    Produce: castSeeds, communityProposals            │
│    Archivo: src/cast-design.ts (NUEVO)              │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  GROUNDING LAYER (deterministic + LLM support)      │
│  ingest → ontology → graph → profiles               │
│  El graph es soporte: grounding, relaciones,        │
│  evidence. NO es la fuente de actores.              │
│  castSeeds informan entity typing en el graph.      │
│  Archivos: ingest.ts, ontology.ts, graph.ts,       │
│  profiles.ts                                        │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  SIMULATION RUNTIME (deterministic, auditable)      │
│  engine → scheduler → feed → propagation            │
│  Sin cambios en este refactor.                      │
└─────────────────────────────────────────────────────┘
```

### Dos contratos separados

| Contrato | Propósito | Usado por |
|----------|-----------|-----------|
| `CastSeed` | Rol/persona para simular (ej: "buy-side macro analyst", "CNBC reporter") | profiles.ts — actor generation |
| `EntityTypeHint` | Tipo correcto para entidad del graph (ej: NVIDIA=organization) | graph.ts — entity typing |

`CastDesign` produce ambos. `castSeeds` se derivan del brief + source docs. `entityTypeHints` se derivan de las entidades mencionadas en los source docs.

### Orden de prioridad de actores
1. `focusActors` del spec (lo que el usuario pidió explícitamente)
2. `castSeeds` del cast-design (lo que el LLM propone a partir de los docs)
3. Entidades del graph, rankeadas por relevancia (complemento)
4. Cap duro por `actorCount`

### Entity ranking (prioridad 3)

Cuando el graph aporta entidades como complemento, se rankean con un score determinístico:

```
score = claimCount * 1.0
      + edgeCount  * 0.5
      + (isFocusActorMatch ? 10.0 : 0.0)
```

Esto asegura que las entidades más conectadas y relevantes del graph se usen primero, no las que aparecen por accidente en el corpus. El ranking solo aplica a la prioridad 3 — `focusActors` y `castSeeds` ya están ordenados por diseño.

Este mecanismo ya existe parcialmente en `buildProfileCandidates` (`profiles.ts`), donde se rankea por `claimTexts.length`. Se extiende con `edgeCount`.

---

## Paso 0: Extraer `mapWithConcurrency` a módulo compartido

**Archivos:**
- **CREAR** `src/concurrency.ts` — mover función de `src/scheduler.ts:236-263`
- **MODIFICAR** `src/scheduler.ts` — import en vez de definición local
- **CREAR** `tests/concurrency.test.ts`

Puro refactor. Pasos 4, 6 y 7 dependen de esto.

---

## Paso 1: Extender `SimulationSpec` y crear contrato `CastDesign`

**Archivos:**
- **MODIFICAR** `src/design.ts` — nuevos tipos
- **CREAR** `src/cast-design.ts` — cast design pass

### Nuevos tipos en `design.ts`:

```typescript
/** Actor role seed for simulation — NOT a graph entity. */
export interface CastSeed {
  name: string;
  type: "person" | "organization" | "media" | "institution";
  role: string;       // "buy-side macro analyst", "CRM platform vendor"
  stance?: string;    // "supportive" | "opposing" | "neutral" | "observer"
  community?: string; // ref a CommunityProposal.name
}

/** Community/faction derived from the simulation hypothesis. */
export interface CommunityProposal {
  name: string;
  description: string;
  memberLabels: string[];  // refs a CastSeed.name o focusActors
}

/** Type hint for graph entity resolution — NOT an actor. */
export interface EntityTypeHint {
  name: string;
  type: string;  // "organization", "person", "media", etc.
}

/** Output of the cast-design pass. */
export interface CastDesign {
  castSeeds: CastSeed[];
  communityProposals: CommunityProposal[];
  entityTypeHints: EntityTypeHint[];
}
```

Campos opcionales en `SimulationSpec`:
```typescript
castDesign?: CastDesign;
```

### Cast-design pass en `src/cast-design.ts` (NUEVO):

Función `designCast(llm, spec, sourceDocSummaries)`:
- Se ejecuta **después** de que los source docs se descarguen
- Input: spec (title, objective, hypothesis, focusActors) + resúmenes de los docs descargados (primeros ~500 chars de cada uno)
- LLM call con prompt que pide:
  - `castSeeds`: actores simulables (personas, empresas, instituciones, medios). NO conceptos abstractos.
  - `communityProposals`: facciones relevantes a la hipótesis, con memberLabels
  - `entityTypeHints`: tipos correctos para entidades mencionadas en los docs
- Output: `CastDesign`
- Fallback: si el LLM falla, retorna `{ castSeeds: [], communityProposals: [], entityTypeHints: [] }` — el pipeline sigue funcionando como antes

### Sequencing en `assistant-tools.ts` (`designSimulationTool`):

El flujo actual es:
1. `designSimulationArtifacts()` → SimulationSpec
2. `materializeSourceDocs()` → descarga URLs
3. Guardar estado

El nuevo flujo es:
1. `designSimulationArtifacts()` → SimulationSpec (sin cambios)
2. `materializeSourceDocs()` → descarga URLs (sin cambios)
3. **NUEVO**: `designCast(llm, spec, docSummaries)` → CastDesign
4. Persistir `castDesign` en el spec JSON
5. Guardar estado

Esto resuelve **P1**: el cast design tiene los docs descargados disponibles.

---

## Paso 2: Entity typing con hints del cast design + ranking (Gap 2)

**Archivos:** `src/graph.ts`, `src/profiles.ts`

### 2a: Entity type hints en graph

Extender `GraphBuildOptions` con `entityTypeHints?: EntityTypeHint[]`.

En `extractEntitiesFromClaims`: al resolver tipo de entidad:
1. **Primero**: match por nombre normalizado contra `entityTypeHints` → usar tipo del hint
2. **Segundo**: fallback a `guessEntityType` existente (se conserva)

**NO se agrega LLM en graph.** El LLM ya actuó en el cast-design pass. El graph es determinista con hints como input.

### 2b: Entity ranking en `buildProfileCandidates`

Extender el ranking existente en `buildProfileCandidates` (`profiles.ts`) de solo `claimTexts.length` a:

```typescript
rank = claimCount * 1.0 + edgeCount * 0.5
```

Donde `edgeCount` se obtiene del store (edges donde la entidad es source o target). Esto mejora la selección de entidades del graph cuando se usan como complemento (prioridad 3).

---

## Paso 3: Comunidades desde propuestas del cast design (Gap 3)

**Archivo:** `src/profiles.ts`

Agregar `communityProposals?: CommunityProposal[]` a `ProfilesOptions`.

Nueva función `assignCommunitiesFromProposals()`:
- Una comunidad por propuesta
- Match de actor.name (normalizado) contra memberLabels
- Actores sin match → fallback a `detectCommunities` existente
- Mismo contrato de retorno: `Map<communityId, string[]>`

En `generateProfiles` (~línea 305): usar propuestas si existen, sino fallback.

---

## Paso 4: Seed posts generados por LLM (Gap 1)

**Archivo:** `src/profiles.ts`

Nueva función `generateSeedPostContent()`:
- Prompt: personalidad, bio, stance, top topics, hipótesis, límite de chars de plataforma
- `llm.completeJSON("generation", ..., { temperature: 0.5, maxTokens: 512 })`
- Respuesta: `{ content: string }`
- Fallback al placeholder actual si LLM falla

Reestructurar bloque de seed posts (~líneas 368-399):
1. Recolectar jobs
2. `mapWithConcurrency(jobs, concurrencyLimit, generateSeedPostContent)`
3. Persistir en DB (secuencial)

`concurrencyLimit` viene de `config.simulation.pipelineConcurrency` (ver Paso 6a).

---

## Paso 5: Search activation via `allowActors` (Gap 5)

**Archivo:** `src/assistant-tools.ts` (o donde se construye la search config para el pipeline)

**NO se overloadea `allowProfessions`** con nombres de actores. En su lugar:

Cuando el cast-design produce `castSeeds`, los nombres de los seeds se agregan a `allowActors` en la search config del pipeline. Esto es semánticamente correcto: `allowActors` es "qué actores específicos pueden buscar", no "qué profesiones".

El flujo:
1. Cast design produce `castSeeds` con roles como "technology journalist", "macro analyst"
2. Al construir la search config para el run, se agregan los cast seed names a `config.search.allowActors`
3. `canActorSearch` en `search.ts:305` ya matchea contra `allowActors` — no necesita cambios

Esto resuelve **P2 (search)**: no se mezclan contratos.

---

## Paso 6: Paralelizar claims extraction + concurrencia configurable

**Archivos:**
- **MODIFICAR** `src/ontology.ts`
- **MODIFICAR** `src/config.ts` (nuevo campo de concurrencia para pipeline)

### 6a: Concurrencia configurable

Agregar a `SimConfig.simulation`:
```typescript
pipelineConcurrency: number;  // default: 3
```

Este valor controla la concurrencia de LLM calls en el pipeline (claims, profiles, seed posts). Es separado de `simulation.concurrency` que controla el scheduler del runtime.

Validación: `pipelineConcurrency >= 1`.

Default: 3 (conservador, evita rate limits sin ser secuencial).

### 6b: Paralelizar claims

Reemplazar for-loop secuencial (~líneas 227-249) con:
```typescript
mapWithConcurrency(chunksToProcess, config.simulation.pipelineConcurrency, extractClaims)
```

Persistencia a DB queda secuencial después.

Esto resuelve **P2 (concurrencia)**: configurable por el usuario, no hardcodeado.

---

## Paso 7: Paralelizar profile generation con tracing

**Archivo:** `src/profiles.ts`

Fase 1: `mapWithConcurrency(candidates, pipelineConcurrency, generateSingleProfile)` — LLM en paralelo
Fase 2: loop secuencial para persistir actors en DB

Usa `config.simulation.pipelineConcurrency`.

### Tracing de paralelización

Agregar métricas observables a las fases paralelas (claims, profiles, seed posts):

```typescript
interface ParallelBatchTrace {
  phase: string;         // "claims" | "profiles" | "seed_posts"
  totalItems: number;
  concurrency: number;
  completedItems: number;
  failedItems: number;
  wallTimeMs: number;
}
```

Cada fase paralela registra su trace via `recordAssistantTrace` (si está disponible) o como log estructurado. Esto permite diagnosticar rate limits, timeouts y cuellos de botella sin adivinar.

---

## Paso 8: Threading end-to-end

**Archivos:**
- `src/simulation-service.ts` — agregar `castDesign?: CastDesign` a `ExecutePipelineInput`; pasar `entityTypeHints` a `buildKnowledgeGraph`, `castSeeds` + `communityProposals` a `generateProfiles`, cast seed names a search `allowActors`
- `src/assistant-tools.ts` — leer castDesign del spec tras cast-design pass, pasarlo a `executePipeline`
- `src/index.ts` — mismo threading para CLI directo

---

## Orden de implementación

```
Paso 0 (concurrency util)
├── Paso 6 (paralelizar claims + pipelineConcurrency config)
├── Paso 7 (paralelizar profiles)
└── Paso 1 (SimulationSpec + CastDesign + cast-design.ts)
    ├── Paso 2 (entity typing con entityTypeHints)
    ├── Paso 3 (comunidades con communityProposals)
    ├── Paso 4 (seed posts LLM)
    └── Paso 5 (search via allowActors)
        └── Paso 8 (threading end-to-end)
```

Cada paso es un commit independiente. Tests existentes no se rompen.

---

## Verificación

1. `npm run build` — sin errores
2. `npm test` — 460+ tests pasan
3. Test manual: re-ejecutar simulación CRM/SaaS NeMoCLAW:
   - Entidades con tipos correctos (NVIDIA=organization, TechCrunch=media)
   - ≥2 comunidades separadas (buy-side, sell-side)
   - Seed posts con contenido real
   - search_requests > 0
   - Diversidad de voz entre actores
4. Backward compat: simulaciones sin castDesign funcionan igual que antes
5. Verificar que `pipelineConcurrency` respeta el valor de config

---

## Archivos críticos

| Archivo | Cambios |
|---------|---------|
| `src/concurrency.ts` | NUEVO — mapWithConcurrency exportado |
| `src/cast-design.ts` | NUEVO — cast design pass (LLM-guided) |
| `src/design.ts` | CastSeed, CommunityProposal, EntityTypeHint, CastDesign types |
| `src/config.ts` | `pipelineConcurrency` field |
| `src/graph.ts` | EntityTypeHint-first entity typing (determinista) |
| `src/profiles.ts` | Community proposals, LLM seed posts, paralelización |
| `src/ontology.ts` | Paralelizar claims extraction |
| `src/search.ts` | Sin cambios (allowActors ya funciona) |
| `src/scheduler.ts` | Import de concurrency.ts |
| `src/simulation-service.ts` | Threading de CastDesign, allowActors |
| `src/assistant-tools.ts` | Cast design pass post-materialization, threading |
| `src/index.ts` | Threading para CLI |

---

## Lo que NO se hace en este refactor

- **No** se agrega LLM en graph.ts — el graph es determinista, recibe hints del cast design
- **No** se reemplaza el pipeline de ontology/graph — se mantiene como soporte/grounding
- **No** se crea un "prompt gigante" que controle todo — el cast design es un paso separado y auditable
- **No** se toca el simulation runtime (engine, scheduler, feed, propagation)
- **No** se overloadea `allowProfessions` con nombres de actores — se usa `allowActors`
- **No** se hardcodea concurrencia — se usa `pipelineConcurrency` de config
