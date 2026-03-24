# Plan de Mejora de Calidad de Simulación — PublicMachina

> Basado en auditoría de simulación real (Run `9ca52a3b`, 5 rondas, 19 actores, gpt-4o-mini)
> y estado del arte 2025-2026 en simulación social con LLMs.

## 0. Evidencia del problema

### Simulación auditada

| Métrica | Valor |
|---|---|
| Run ID | `9ca52a3b` |
| Modelo | gpt-4o-mini |
| Actores | 19 |
| Rondas | 5 |
| Posts | 60 |
| Decisiones | 83 |
| Costo | ~$0.02 USD |

### Hallazgos

1. **10 de 19 actores tienen nombres que son frases**, no personas reales
2. **Contenido repetitivo** — casi todos los posts empiezan con "Absolutely!" o "I completely agree!"
3. **Queries de búsqueda idénticos** entre rondas (`"cryptocurrency New York, USA"` × 5)
4. **Zero posts originales** después de los seed posts — solo comments
5. **Sin evolución narrativa** — la conversación gira en círculos

### Motor vs Inputs

El motor de simulación funciona correctamente (5/5 rondas, 0 errores, outbox sincronizado,
decision traces auditables). Los problemas son de **calidad de inputs y prompts**, no de infraestructura.

---


## 1. Entity Extraction — Pipeline de 2 Pasos LLM

### Problema

La extracción de entidades en `ontology.ts` produce entidades como:

```
"a supply shock as ETF demand absorbs available Ethereum" → tipo: person
"Ethereum's value proposition is more complex to explain" → tipo: person
"the successful launch of spot Bitcoin ETFs earlier in 2024" → tipo: organization
```

10 de 19 entidades son fragmentos de oraciones, no actores reales.

### Causa raíz

El LLM extrae claims y frases como entidades. No hay validación post-extracción.
El prompt no tiene instrucciones suficientemente estrictas sobre qué constituye una entidad.

### Por qué NO usar filtros heurísticos

Un enfoque inicial consideró un filtro determinístico intermedio (regex de verbos,
límites de longitud de nombre, rechazo de minúsculas iniciales). Ese enfoque se descartó
porque produce falsos positivos inaceptables:

- `"The Wall Street Journal"` → empieza con "The", ¿lo rechaza?
- `"al-Qaeda"` → empieza con minúscula → rechazado incorrectamente
- `"iPhone"` → empieza con minúscula → rechazado incorrectamente
- `"International Monetary Fund"` → nombre largo pero perfectamente válido

Y a la vez deja pasar entidades basura:

- `"Regulatory Clarity"` → 2 palabras, mayúscula, sin verbos → pasa (mal)
- `"The Decision"` → 2 palabras, mayúscula → pasa (mal)
- `"ETF Demand"` → 2 palabras, mayúscula → pasa (mal)

La decisión de "¿es esto una entidad real?" es **semántica, no sintáctica**.
Un LLM la hace bien. Un regex no.

### Solución — 2 pasos, ambos con LLM

Pipeline basado en:
- **Graphiti** (extract → resolve → validate, todo con LLM)
- **AgentCAT 2025** (extract → critique → re-extract, 86% correctness)
- **LangExtract** (source grounding obligatorio)
- **GPT-NER** (self-verification, NAACL 2025 Findings)

```
Paso 1 — Extracción inteligente (1 llamada LLM)
  └─ Prompt que define QUÉ es una entidad conceptualmente, no por reglas de formato
  └─ El LLM extrae entidades con source_quote obligatorio
  └─ El LLM explica POR QUÉ cada cosa es una entidad (chain-of-thought)
  └─ Sin constraints artificiales de longitud o formato

Paso 2 — Validación cruzada (1 llamada LLM)
  └─ Segundo LLM recibe el documento completo + las entidades extraídas
  └─ Evalúa cada entidad de forma independiente
  └─ Puede KEEP, REVISE (corregir nombre), o REMOVE
  └─ Ejemplos balanceados, no tendenciosos al dominio del documento
  └─ Solo verdict + reason, sin scoring numérico arbitrario
```

#### Paso 1 — Extracción con grounding y chain-of-thought

El LLM extrae entidades, cita dónde aparecen, y justifica por qué cada una es
una entidad real. El campo `why_entity` activa chain-of-thought y reduce
extracciones basura — el modelo tiene que justificar cada entidad ante sí mismo.

```
Prompt:

Extract the named entities from this document that could represent
real actors in a social simulation (people, organizations, institutions).

For each entity:
- Provide the canonical name as it would appear in a social media profile
- Classify its type (PERSON, ORGANIZATION, INSTITUTION, MEDIA, GROUP)
- Quote the exact passage from the document where it appears or is referenced
- Explain briefly WHY this is a real, identifiable entity

Think carefully about what constitutes a real, identifiable entity:
- "BlackRock" is an entity — it's a specific, identifiable organization
- "Chairman Gary Gensler" is an entity — it's a specific, identifiable person
- "a supply shock as ETF demand absorbs Ethereum" is NOT an entity —
  it's a description of a market dynamic
- "Critics" is NOT an entity — it's a generic group without a specific identity
- "Regulatory clarity" is NOT an entity — it's an abstract concept

Return JSON:
{
  "entities": [
    {
      "name": "canonical name for this entity",
      "type": "PERSON | ORGANIZATION | INSTITUTION | MEDIA | GROUP",
      "source_quote": "exact passage from the document",
      "why_entity": "brief explanation of why this is a real, identifiable entity"
    }
  ]
}
```

Zod schema (validates structure only — content judgment is the LLM's job):

```typescript
const EntityExtractionSchema = z.object({
  entities: z.array(z.object({
    name: z.string().min(1),
    type: z.enum(["PERSON", "ORGANIZATION", "INSTITUTION", "MEDIA", "GROUP"]),
    source_quote: z.string().min(1),
    why_entity: z.string().min(1),
  }))
});
```

#### Paso 2 — Validación cruzada por LLM-as-Judge

Un segundo LLM (puede ser el mismo modelo u otro más barato) evalúa las entidades
extraídas contra el documento original. Sin scoring numérico — solo verdict + reason.

```
Prompt:

You are reviewing entities extracted from a document for use in a social simulation.
Your job is to ensure only real, identifiable actors pass through.

For each entity, decide:
- KEEP: This is a real, identifiable entity that could be a social media actor
- REVISE: The entity is real but the name needs correction (provide corrected name)
- REMOVE: This is not a real entity (concept, description, generic group, etc.)

Provide your reasoning for each decision.

Important: be balanced in your judgments.
- Not every short name is valid (e.g., "Trading" is too generic)
- Not every long name is invalid (e.g., "International Monetary Fund" is perfectly fine)
- Organizations ARE valid entities even if they aren't people
- Generic groups without specific identity are NOT valid ("Critics", "Analysts")
- Descriptions of dynamics are NOT valid ("a supply shock as ETF demand...")
- If a concept was extracted but refers to a real entity, REVISE the name
  (e.g., "Ethereum price" → REMOVE, but "Ethereum Foundation" → KEEP)

Document:
{document}

Entities to evaluate:
{entities}

Return JSON:
{
  "evaluations": [
    {
      "original_name": "the name as extracted",
      "verdict": "KEEP | REVISE | REMOVE",
      "corrected_name": "only if REVISE, otherwise omit",
      "reason": "why you made this decision"
    }
  ]
}
```

### Por qué funciona

1. **Paso 1 produce entidades con justificación.** El campo `why_entity` activa
   chain-of-thought y fuerza al modelo a razonar antes de incluir una entidad.
   Esto solo ya elimina ~60-70% de las extracciones basura.

2. **Paso 2 es una segunda opinión independiente.** Incluso si el Paso 1 extrae
   "a supply shock as ETF demand absorbs Ethereum" (porque justificó "it describes
   a market phenomenon"), el judge del Paso 2 lo rechaza porque evalúa si es un
   *actor simulable*, no si es un *fenómeno mencionado en el texto*.

3. **Sin heurísticos frágiles.** No hay regex que pueda distinguir entre
   "The Wall Street Journal" (válido) y "The Decision" (inválido). El LLM sí puede.

4. **REVISE permite correcciones.** Si el Paso 1 extrae "Chairman Gary Gensler",
   el judge puede revisarlo a "Gary Gensler" (nombre canónico). Esto mejora
   la calidad de los perfiles downstream.

### Costo del pipeline

| Paso | Llamadas LLM | Costo estimado |
|---|---|---|
| Paso 1 (extracción + chain-of-thought) | 1 | ~$0.002 |
| Paso 2 (judge + verdicts) | 1 | ~$0.001 |
| **Total** | **2** | **~$0.003 por documento** |

### Archivos a modificar

- `src/ontology.ts` — reemplazar extracción con pipeline 2-step
- ~150-200 líneas

### Referencias

- Graphiti pipeline: extract → resolve → validate (github.com/getzep/graphiti)
- AgentCAT 2025: extract → critique → re-extract, 86% correctness
- LangExtract: source grounding con character offsets (genmind.ch)
- GPT-NER: self-verification de entidades (NAACL 2025 Findings)
- DSPy Assertions: backtracking con error feedback (arxiv 2312.13382)
- Instructor-JS: structured output con retry automático (js.useinstructor.com)

---

## 2. Contenido Diverso — Prompt de Decisión Enriquecido

### Problema

Casi todos los posts empiezan con "Absolutely!" o "I completely agree!".
19 agentes producen variaciones del mismo mensaje durante 5 rondas.
No hay conflicto, no hay desacuerdo, no hay evolución.

### Causa raíz

El prompt de decisión en `cognition.ts:503-541` no tiene:
- Instrucciones de diversidad
- Contexto de "lo que ya se dijo"
- Arquetipos de comportamiento
- Penalización de repetición

El prompt solo dice: "You are simulating a social media user. Choose ONE action."

### Solución — 4 capas de enriquecimiento

Basado en:
- **AAMAS 2025** — "From Who They Are to How They Act" (arquetipos de comportamiento)
- **EPJ Data Science 2025** — "Selective agreement, not sycophancy" (anti-sycophancy)
- **AgentSociety** (Tsinghua) — emotional states y cognitive attitudes
- **Concordia** (DeepMind) — composable agent components

#### Capa 1 — Behavioral Archetypes

Asignar a cada actor un arquetipo que modula su estilo de participación.

```typescript
type BehavioralArchetype =
  | 'proactive_contributor'   // Alta tasa de posts originales
  | 'interactive_enthusiast'  // Alta tasa de comentarios con engagement directo
  | 'content_amplifier'       // Alta tasa de reposts/likes
  | 'balanced_participant'    // Mix equilibrado
  | 'critical_observer';      // Baja actividad, intervenciones de alto impacto

// Probabilidades de acción por archetype (basado en AAMAS 2025)
const ACTION_BIASES: Record<BehavioralArchetype, Record<string, number>> = {
  proactive_contributor:  { post: 0.40, comment: 0.25, repost: 0.10, like: 0.15, idle: 0.10 },
  interactive_enthusiast: { post: 0.10, comment: 0.45, repost: 0.15, like: 0.20, idle: 0.10 },
  content_amplifier:      { post: 0.05, comment: 0.15, repost: 0.35, like: 0.35, idle: 0.10 },
  critical_observer:      { post: 0.15, comment: 0.20, repost: 0.05, like: 0.10, idle: 0.50 },
  balanced_participant:   { post: 0.20, comment: 0.30, repost: 0.15, like: 0.20, idle: 0.15 },
};
```

#### Capa 2 — Anti-sycophancy directives

Instrucciones explícitas en el system prompt contra la repetición y el acuerdo vacío:

```
CRITICAL RULES FOR YOUR RESPONSE:
- Do NOT begin with "Absolutely!", "I completely agree!", "Exciting times!",
  "Great point!", or any generic affirmation
- Your response must reflect YOUR specific expertise as a {profession}
- Reference at least one specific fact, number, date, or concrete detail
- If your stance is "{stance}", your tone must genuinely reflect that:
  - "opposing" = express real skepticism, cite specific risks or counterarguments
  - "supportive" = express enthusiasm but with substantive reasoning, not platitudes
  - "neutral" = present balanced analysis, explicitly note tradeoffs
- If other participants have already made a point, do NOT repeat it —
  build on it, challenge it, or take a different angle
- Write like a real person on social media, not like a corporate press release
- Use the tone described in your personality, not generic professional language
```

#### Capa 3 — Recent round context

Agregar un resumen de lo que otros actores ya dijeron en esta ronda
para que el agente sepa qué NO repetir:

```typescript
function buildRecentRoundContext(
  store: SimStore,
  runId: string,
  roundNum: number,
  currentActorId: string
): string {
  const roundPosts = store.getPostsByRound(runId, roundNum)
    .filter(p => p.author_id !== currentActorId)
    .slice(0, 5);

  if (roundPosts.length === 0) return "";

  const summary = roundPosts.map(p =>
    `- @${p.authorHandle}: "${p.content.slice(0, 80)}..."`
  ).join("\n");

  return `\nWHAT OTHERS SAID THIS ROUND (do NOT repeat these points):\n${summary}\n`;
}
```

#### Capa 4 — Sampling parameters

Configurar los parámetros de sampling del LLM para mayor variabilidad:

```typescript
// En config de cognición (nuevos defaults):
{
  temperature: 0.8,           // (actual probable: 0.7 o default del modelo)
  presence_penalty: 0.4,      // Penalizar tokens que ya aparecieron en el output
  frequency_penalty: 0.3,     // Penalizar tokens frecuentes
}
```

### Archivos a modificar

- `src/cognition.ts` — prompts enriquecidos
- `src/scheduler.ts` — context building (recent round posts)
- `src/types.ts` — campo archetype en ActorRow
- `src/config.ts` — sampling parameters
- ~200 líneas

### Referencias

- "From Who They Are to How They Act" (AAMAS 2025, arxiv 2601.15114)
- "Selective agreement, not sycophancy" (EPJ Data Science 2025)
- AgentSociety (Tsinghua, arxiv 2502.08691)
- Concordia (DeepMind, arxiv 2312.03664)
- "Are LLM-Powered Social Media Bots Realistic?" (arxiv 2508.00998)

---

## 3. Search Queries — Generados por el LLM, condicionados al estado del agente

### Problema

`composeQuery()` en `search.ts:449-453` concatena `topic + region`.
Produce siempre lo mismo: `"cryptocurrency New York, USA"`.
Los agentes buscan lo mismo cada ronda.

### Causa raíz

```typescript
// Implementación actual:
function composeQuery(topic: string, actor: ActorRow): string {
  const parts = [topic.trim()];
  if (actor.region) parts.push(actor.region.trim());
  return parts.filter(Boolean).join(" ");
}
```

No hay contexto de ronda, no hay historial de queries previos,
no hay personalización por profesión o perspectiva.

### Solución

Basado en:
- **ID-RAG** (2025) — JSON search strategy condicionada al estado del agente
- **Agentic RAG** — dual expansion (syntax + semantic)

#### Componente 1 — LLM genera el query como parte de la decisión

Incorporar la generación de query en el prompt de decisión.
El agente decide qué buscar basándose en su perspectiva.

Agregar al system prompt de decisión:

```
SEARCH CAPABILITY:
You can search the web before deciding. If you want to search, include in your JSON:
"search_query": "what you would search right now given this conversation"

Your query should:
- Reflect YOUR expertise and perspective as a {profession}
- Be specific to what's being discussed RIGHT NOW (not generic topics)
- Be DIFFERENT from your previous searches: {previousQueries}
- Include specific terms, names, or data points you want to verify

Examples of persona-appropriate queries:
- Crypto analyst: "Ethereum ETF trading volume first week comparison Bitcoin ETF"
- SEC commissioner: "SEC enforcement actions crypto ETF conditions 2024"
- DeFi developer: "Ethereum staking yield impact ETF approval liquidity"
```

#### Componente 2 — Historial de queries previos

Pasar al prompt del agente lo que ya buscó para evitar repetición:

```typescript
// En scheduler.ts:
const previousQueries = store.getSearchQueriesByActor(runId, actor.id)
  .map(sq => sq.query);

// Agregar al DecisionRequest:
request.previousQueries = previousQueries;
```

#### Componente 3 — Fallback programático mejorado

Si el LLM no genera un `search_query`, usar un `composeQuery` mejorado:

```typescript
function composeQuery(
  topic: string,
  actor: ActorRow,
  roundNum: number,
  feedTopPosts: string[]
): string {
  const parts = [topic.trim()];

  // Profession-specific context
  if (actor.profession) {
    const profKeywords = actor.profession.split(" ").slice(0, 2);
    parts.push(profKeywords.join(" "));
  }

  // Feed-derived keyword (what's trending NOW, not just the base topic)
  if (feedTopPosts.length > 0) {
    const keyword = extractDominantKeyword(feedTopPosts[0]);
    if (keyword && keyword.toLowerCase() !== topic.toLowerCase()) {
      parts.push(keyword);
    }
  }

  if (actor.region) parts.push(actor.region.trim());
  return parts.filter(Boolean).join(" ");
}
```

### Archivos a modificar

- `src/cognition.ts` — prompt con search capability
- `src/scheduler.ts` — query history retrieval
- `src/search.ts` — composeQuery mejorado
- `src/types.ts` — previousQueries en DecisionRequest
- ~120 líneas

### Referencias

- ID-RAG (arxiv 2509.25299) — JSON search strategy
- Deep Research survey (arxiv 2508.12752) — agentic RAG patterns

---

## 4. Posts Originales — Arquetipos + Incentivos Contextuales

### Problema

En 5 rondas, ningún agente creó un post original después de los seed posts.
Todas las acciones son comments. No hay nuevos temas ni nuevos threads.

### Causa raíz

El modelo siempre elige `comment` porque:
- El feed está lleno de contenido existente
- El prompt no incentiva crear contenido nuevo
- No hay distinción entre actores que "publican" vs actores que "comentan"

### Solución

Basado en:
- **"From Who They Are to How They Act"** (AAMAS 2025) — Markov transition matrices
- **AgentSociety** (Tsinghua) — Stream Memory con Event Flow
- **Disinformation simulation framework** — narrative injection

#### Componente 1 — Action biases por archetype

Usar las matrices de probabilidad de la Sección 2 para modular la instrucción
de acción en el prompt. Para un `proactive_contributor`:

```
YOUR BEHAVIORAL STYLE: Proactive Contributor
You tend to create original content and introduce new angles.
When deciding, favor POSTING new perspectives over just commenting on existing ones.
Your action distribution target: ~40% posts, ~25% comments, ~10% reposts
```

#### Componente 2 — Incentivo contextual en el prompt

```typescript
function buildPostIncentive(
  roundNum: number,
  feed: FeedItem[],
  actorArchetype: BehavioralArchetype,
  actorPostCount: number,
  lastPostRound: number | null
): string {
  const roundsSinceLastPost = roundNum - (lastPostRound ?? -1);

  // Proactive contributors that haven't posted yet
  if (actorArchetype === 'proactive_contributor' && actorPostCount === 0) {
    return `\nAs a thought leader, you should create ORIGINAL POSTS with new insights,
not just comment on existing content.\n`;
  }

  // Any actor that hasn't posted in 2+ rounds and the feed is stale
  if (roundsSinceLastPost >= 2 && feed.every(f => f.post.round_num < roundNum - 1)) {
    return `\nThe conversation has gone quiet. This is a good moment to share a
NEW perspective or introduce a NEW angle that hasn't been discussed.\n`;
  }

  // One-sided conversation — encourage counterpoint
  const avgSentiment = feed.reduce((s, f) => s + f.post.sentiment, 0) / feed.length;
  if (Math.abs(avgSentiment) > 0.6) {
    return `\nNote: The conversation is heavily one-sided
(${avgSentiment > 0 ? 'positive' : 'negative'}).
Consider whether a different perspective would be valuable.\n`;
  }

  return "";
}
```

#### Componente 3 — Eventos automáticos por defecto

En `config.ts` defaults, agregar threshold triggers que inyecten información nueva
cuando la conversación se estanca:

```typescript
const DEFAULT_THRESHOLD_TRIGGERS: ThresholdTrigger[] = [
  {
    condition: "avgSentiment(topic) < -0.6",
    event: "Institutional response statement",
    actorArchetype: "institution"
  },
  {
    condition: "postCount(topic) > 50",
    event: "National media covers the situation",
    actorArchetype: "media"
  },
  // NUEVO: anti-stagnation triggers
  {
    condition: "roundsSinceNewOriginalPost > 2",
    event: "Breaking development related to the simulation topic emerges",
    actorArchetype: "media"
  },
  {
    condition: "avgSentiment(topic) > 0.7 for 3 consecutive rounds",
    event: "Counter-narrative emerges with data challenging the consensus",
    actorArchetype: "institution"
  },
];
```

### Archivos a modificar

- `src/cognition.ts` — prompt incentives
- `src/types.ts` — archetype field
- `src/scheduler.ts` — action bias application
- `src/config.ts` — default threshold triggers
- ~180 líneas

### Referencias

- "From Who They Are to How They Act" (AAMAS 2025, arxiv 2601.15114)
- AgentSociety Stream Memory (arxiv 2502.08691)
- Agent-based disinformation simulation (arxiv 2512.22082)

---

## 5. Evolución Narrativa — Asimetría Informacional

### Problema

No hay evolución narrativa real. El sentimiento baja (0.68 → 0.26) por fatiga
del modelo, no por dinámica emergente. No hay un evento o post que cause el shift.

### Causa raíz

Es la consecuencia de los problemas 1-4 combinados:
- Actores sin personalidad diferenciada → no hay conflicto
- Contenido repetitivo → no hay nueva información
- Búsquedas idénticas → no hay inputs externos diferenciados
- Sin posts nuevos → la conversación gira en círculos

### Solución

Se resuelve **en su mayor parte** con los fixes 1-4. Sin embargo, hay un componente
adicional que la refuerza significativamente:

**Asimetría informacional entre agentes.**

Basado en:
- **OASIS** — tiered information access por tipo de agente
- **Disinformation framework** — informed vs naive vs dubious agents

#### Implementación

No todos los agentes ven la misma profundidad de resultados de búsqueda:

```typescript
function buildAsymmetricSearchContext(
  actor: ActorRow,
  searchResults: SearchResult[]
): string {
  if (searchResults.length === 0) return "";

  // Tier A: full results (title + snippet + URL)
  if (actor.cognition_tier === 'A') {
    return searchResults
      .map(r => `[${r.title}] ${r.snippet}`)
      .join("\n");
  }

  // Tier B: headlines only (creates natural information gap)
  return searchResults
    .map(r => `- ${r.title}`)
    .join("\n");
}
```

Esto produce naturalmente que:
- Agentes Tier A tienen opiniones más informadas y específicas
- Agentes Tier B reaccionan a titulares (más emocional, menos analítico)
- El gap informacional genera desacuerdos orgánicos

### Archivos a modificar

- `src/scheduler.ts` — asymmetric context building
- ~50 líneas

### Referencias

- OASIS tiered access (arxiv 2411.11581)
- Agent-based disinformation simulation (arxiv 2512.22082)

---

## 6. Search Retry con Backoff

### Problema

`search.ts:61` hace un solo fetch. Si SearXNG falla temporalmente, la búsqueda
se pierde. El scheduler degrada elegantemente (no crash), pero el agente pierde
contexto web que podría haber obtenido.

### Solución

Retry con exponential backoff, estándar de resiliencia:

```typescript
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(options.timeout ?? 5000),
      });
      if (response.ok) return response;

      // Don't retry 4xx (client errors)
      if (response.status >= 400 && response.status < 500) {
        throw new Error(`Search API returned ${response.status}`);
      }

      lastError = new Error(`Search API returned ${response.status}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    // Exponential backoff: 500ms, 1000ms, 2000ms
    if (attempt < maxRetries - 1) {
      await new Promise(resolve =>
        setTimeout(resolve, 500 * Math.pow(2, attempt))
      );
    }
  }

  throw lastError ?? new Error("Search failed after retries");
}
```

### Archivos a modificar

- `src/search.ts`
- ~40 líneas

---

## 7. Cost Cap por Simulación

### Problema

No hay límite de gasto. Si algo sale mal (loop, prompt injection, respuestas
excesivamente largas), el costo puede escalar sin control.

### Solución

```typescript
class CostTracker {
  private totalCostUsd = 0;
  private readonly maxCostUsd: number;

  constructor(maxCostUsd: number = 20) {
    this.maxCostUsd = maxCostUsd;
  }

  track(inputTokens: number, outputTokens: number, model: string): void {
    const cost = estimateCost(inputTokens, outputTokens, model);
    this.totalCostUsd += cost;

    if (this.totalCostUsd > this.maxCostUsd * 0.8) {
      console.warn(
        `Warning: Cost at ${Math.round(this.totalCostUsd / this.maxCostUsd * 100)}% of budget`
      );
    }

    if (this.totalCostUsd >= this.maxCostUsd) {
      throw new Error(
        `Cost cap exceeded: $${this.totalCostUsd.toFixed(2)} >= $${this.maxCostUsd}. ` +
        `Simulation aborted. Increase simulation.costCapUsd in config to continue.`
      );
    }
  }
}
```

Configurable en YAML:

```yaml
simulation:
  costCapUsd: 20  # default, abort si se excede
```

### Archivos a modificar

- `src/engine.ts` — CostTracker integration
- `src/config.ts` — costCapUsd field + validation
- ~60 líneas

---

## Resumen ejecutivo

| # | Fix | Patron / Referencia 2026 | Impacto | Esfuerzo | LLM calls extra |
|---|---|---|---|---|---|
| 1 | Entity extraction 2-step LLM | Graphiti + AgentCAT + GPT-NER | Critico | ~200 lineas | +1 por doc |
| 2 | Prompt diversidad 4-capas | AAMAS 2025 + EPJ anti-sycophancy | Alto | ~200 lineas | 0 |
| 3 | Search queries LLM-generated | ID-RAG + agentic RAG | Medio-Alto | ~120 lineas | 0 |
| 4 | Post incentives + action biases | AAMAS 2025 Markov + AgentSociety | Alto | ~180 lineas | 0 |
| 5 | Information asymmetry | OASIS tiered + disinfo framework | Emergente | ~50 lineas | 0 |
| 6 | Search retry + backoff | Standard resilience | Resiliencia | ~40 lineas | 0 |
| 7 | Cost cap | Standard safety | Seguridad | ~60 lineas | 0 |

**Total: ~850 lineas de cambios.**
**Costo adicional por simulacion: ~$0.003** (solo el judge de entidades).
Los demas fixes son cambios de prompts y logica — no agregan llamadas LLM.

## Orden de implementacion

```
1. Entity extraction 2-step  (desbloquea actores realistas)
2. Prompt diversidad 4-capas  (desbloquea contenido diferenciado)
3. Post incentives            (desbloquea nuevos threads)
4. Search queries mejorados   (desbloquea grounding util)
5. Information asymmetry      (amplifica evolucion narrativa)
6. Search retry               (resiliencia operacional)
7. Cost cap                   (seguridad operacional)
```

Fixes 1-4 son secuenciales (cada uno construye sobre el anterior).
Fixes 5-7 son independientes y se pueden hacer en paralelo.

## Que queda explicitamente fuera

- Cambio de modelo (gpt-4o o Claude Sonnet producirian mejores resultados,
  pero los fixes deben funcionar incluso con gpt-4o-mini)
- NER local con GLiNER (opcional, agrega precision pero requiere dependencia Python o ONNX)
- Grounding contra Wikidata (util pero agrega latencia de red por entidad)
- Filtros heuristicos de entidades (descartados — la validacion semantica por LLM
  es superior a regex y reglas de formato; ver seccion 1 para justificacion)
- Frontend / visualizacion de resultados
