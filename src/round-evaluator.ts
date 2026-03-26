/**
 * round-evaluator.ts — Independent round quality evaluator
 *
 * Implements the Generator-Evaluator pattern from Anthropic's harness design:
 * https://www.anthropic.com/engineering/harness-design-long-running-apps
 *
 * After each round, an independent LLM evaluates the quality of agent outputs
 * and flags issues (repetition, broken character, low diversity). This feedback
 * can trigger corrective actions in subsequent rounds.
 *
 * Key insight: agents are lenient when self-evaluating. A separate evaluator
 * catches quality issues the generator would miss.
 */

import type { LLMClient } from "./llm.js";
import type { GraphStore } from "./store.js";
import type { Post, ActorRow } from "./db.js";

export interface RoundEvaluation {
  roundNum: number;
  scores: {
    /** 1-5: Are agent voices distinguishable from each other? */
    diversity: number;
    /** 1-5: Did opinions/positions evolve from the previous round? */
    evolution: number;
    /** 1-5: Are agents staying in character (profession, stance)? */
    consistency: number;
    /** 1-5: Is there genuine disagreement/tension between agents? */
    conflict: number;
  };
  /** Average of all scores */
  overallScore: number;
  /** Specific issues detected */
  issues: string[];
  /** Suggested corrective actions for next round */
  suggestions: string[];
  /** Raw LLM response for audit trail */
  rawResponse: string;
}

export interface RoundEvaluatorConfig {
  enabled: boolean;
  /** Minimum overall score to consider a round "healthy" (default: 2.5) */
  healthThreshold: number;
}

export const DEFAULT_EVALUATOR_CONFIG: RoundEvaluatorConfig = {
  enabled: false,
  healthThreshold: 2.5,
};

/**
 * Evaluate the quality of a completed round's outputs.
 * Uses a single cheap LLM call to score diversity, evolution, consistency, and conflict.
 */
export async function evaluateRound(
  llm: LLMClient,
  store: GraphStore,
  runId: string,
  roundNum: number,
): Promise<RoundEvaluation> {
  // Gather posts from this round and previous round via SQL
  const roundPosts = store.executeReadOnlySql(
    `SELECT p.*, a.handle, a.stance, a.profession FROM posts p
     JOIN actors a ON p.author_id = a.id
     WHERE p.run_id = '${runId}' AND p.round_num = ${roundNum}
     ORDER BY p.sim_timestamp`
  ) as unknown as Array<{ handle: string; stance: string; profession: string; content: string }>;

  const prevRoundPosts = roundNum > 0
    ? store.executeReadOnlySql(
        `SELECT p.*, a.handle, a.stance FROM posts p
         JOIN actors a ON p.author_id = a.id
         WHERE p.run_id = '${runId}' AND p.round_num = ${roundNum - 1}
         ORDER BY p.sim_timestamp LIMIT 10`
      ) as unknown as Array<{ handle: string; stance: string; content: string }>
    : [];

  // Build the content summary for evaluation
  const roundSummary = roundPosts.slice(0, 20).map((p) =>
    `[@${p.handle} | ${p.stance} | ${p.profession}]: ${p.content.slice(0, 200)}`
  ).join("\n\n");

  const prevSummary = prevRoundPosts.slice(0, 10).map((p) =>
    `[@${p.handle}]: ${p.content.slice(0, 150)}`
  ).join("\n\n");

  const prompt = `Evaluate the quality of this simulation round's outputs.

ROUND ${roundNum} POSTS (${roundPosts.length} total, showing up to 20):
${roundSummary || "(no posts this round)"}

${prevSummary ? `PREVIOUS ROUND POSTS (for comparison):\n${prevSummary}` : "(first round, no previous)"}

Score each dimension 1-5:
- diversity: Are agent voices distinguishable? (1=all identical, 5=each unique)
- evolution: Did positions evolve from previous round? (1=copy-paste, 5=clear progression)
- consistency: Are agents staying in character? (1=broken personas, 5=fully authentic)
- conflict: Is there genuine disagreement? (1=everyone agrees, 5=real tension)

Also list:
- issues: specific problems you noticed (e.g., "3 agents used identical opening phrases")
- suggestions: what should change next round (e.g., "inject a disruptive event")

Return JSON:
{
  "diversity": <1-5>,
  "evolution": <1-5>,
  "consistency": <1-5>,
  "conflict": <1-5>,
  "issues": ["issue1", "issue2"],
  "suggestions": ["suggestion1"]
}`;

  try {
    const response = await llm.completeJSON<{
      diversity: number;
      evolution: number;
      consistency: number;
      conflict: number;
      issues: string[];
      suggestions: string[];
    }>("simulation", prompt, {
      system: "You are a simulation quality evaluator. Be critical and specific. Do not praise — find problems. Score honestly: most rounds should be 2-3, not 4-5.",
      temperature: 0.3,
      maxTokens: 400,
      allowRepair: true,
    });

    const scores = {
      diversity: clamp(response.data.diversity ?? 3, 1, 5),
      evolution: clamp(response.data.evolution ?? 3, 1, 5),
      consistency: clamp(response.data.consistency ?? 3, 1, 5),
      conflict: clamp(response.data.conflict ?? 3, 1, 5),
    };

    const overallScore = (scores.diversity + scores.evolution + scores.consistency + scores.conflict) / 4;

    return {
      roundNum,
      scores,
      overallScore,
      issues: response.data.issues ?? [],
      suggestions: response.data.suggestions ?? [],
      rawResponse: JSON.stringify(response.data),
    };
  } catch {
    // Evaluator failure should never stop the simulation
    return {
      roundNum,
      scores: { diversity: 0, evolution: 0, consistency: 0, conflict: 0 },
      overallScore: 0,
      issues: ["Round evaluator failed to execute"],
      suggestions: [],
      rawResponse: "{}",
    };
  }
}

/**
 * Build a "round guidance" string from evaluation results.
 * This gets injected into the next round's decision prompts to
 * steer agents away from detected quality issues.
 */
export function buildRoundGuidance(evaluation: RoundEvaluation): string | null {
  if (evaluation.overallScore === 0) return null; // evaluator failed
  if (evaluation.overallScore >= 4.0) return null; // round was good enough

  const parts: string[] = [];

  if (evaluation.scores.diversity <= 2) {
    parts.push("IMPORTANT: Your voice should be DISTINCTLY different from other actors. Do NOT use generic phrases like 'exciting times' or 'significant milestone'. Speak in YOUR unique style based on your profession and personality.");
  }

  if (evaluation.scores.evolution <= 2) {
    parts.push("IMPORTANT: Do NOT repeat what you said before. Your position should EVOLVE based on new information and the ongoing conversation. Take a new angle or deepen your argument.");
  }

  if (evaluation.scores.conflict <= 2) {
    parts.push("IMPORTANT: If you disagree with the prevailing sentiment, SAY SO directly. Do not soften your position to agree with others. Genuine disagreement makes the conversation valuable.");
  }

  if (evaluation.issues.length > 0) {
    parts.push(`Quality issues from previous round: ${evaluation.issues.slice(0, 2).join("; ")}`);
  }

  return parts.length > 0 ? parts.join("\n") : null;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
