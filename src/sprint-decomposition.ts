/**
 * sprint-decomposition.ts — Sprint-based simulation decomposition
 *
 * For simulations >10 rounds, divides the run into sprints of 5-10 rounds.
 * Between sprints, a narrative checkpoint summarizes emergent dynamics
 * and sets objectives for the next sprint.
 *
 * Based on Anthropic's harness design pattern:
 * https://www.anthropic.com/engineering/harness-design-long-running-apps
 *
 * Sprint contracts define what "done" means before implementation begins,
 * reducing drift in long-running simulations.
 */

export interface SprintContract {
  sprintNumber: number;
  startRound: number;
  endRound: number;
  /** What this sprint should accomplish narratively */
  objective: string;
  /** Success criteria — what constitutes a "healthy" sprint */
  successCriteria: string[];
}

export interface SprintCheckpoint {
  sprintNumber: number;
  completedRound: number;
  /** Emergent narratives detected */
  narratives: string[];
  /** Key relationship changes */
  relationshipChanges: string[];
  /** Stance/opinion shifts */
  stanceShifts: string[];
  /** Guidance for next sprint */
  nextSprintGuidance: string;
}

/**
 * Generate sprint contracts for a simulation run.
 * Divides total rounds into sprints of ~5 rounds each.
 */
export function generateSprintContracts(
  totalRounds: number,
  hypothesis?: string
): SprintContract[] {
  if (totalRounds <= 5) {
    // Short simulation — single sprint, no decomposition needed
    return [{
      sprintNumber: 0,
      startRound: 0,
      endRound: totalRounds - 1,
      objective: hypothesis ?? "Complete simulation",
      successCriteria: ["At least 2 actors express differing viewpoints"],
    }];
  }

  const sprintSize = Math.min(5, Math.ceil(totalRounds / 3));
  const sprints: SprintContract[] = [];
  let start = 0;

  const defaultPhases = [
    {
      objective: "Initial reactions and position-taking",
      criteria: [
        "Each actor establishes a distinct voice",
        "At least 2 opposing viewpoints emerge",
        "Key information from sources is referenced",
      ],
    },
    {
      objective: "Deepening positions and emerging conflicts",
      criteria: [
        "At least 1 actor changes or refines their position",
        "New arguments emerge beyond initial reactions",
        "Cross-actor engagement (replies, quotes) increases",
      ],
    },
    {
      objective: "Resolution, escalation, or narrative crystallization",
      criteria: [
        "Clear narrative camps have formed",
        "At least 1 relationship has changed (follow/unfollow/block)",
        "The conversation has moved beyond the initial event",
      ],
    },
  ];

  let phaseIndex = 0;
  while (start < totalRounds) {
    const end = Math.min(start + sprintSize - 1, totalRounds - 1);
    const phase = defaultPhases[Math.min(phaseIndex, defaultPhases.length - 1)];
    sprints.push({
      sprintNumber: phaseIndex,
      startRound: start,
      endRound: end,
      objective: phase.objective,
      successCriteria: phase.criteria,
    });
    start = end + 1;
    phaseIndex++;
  }

  return sprints;
}

/**
 * Check if we're at a sprint boundary (end of a sprint).
 * Returns the completed sprint contract if so, null otherwise.
 */
export function getCompletedSprint(
  roundNum: number,
  sprints: SprintContract[]
): SprintContract | null {
  return sprints.find((s) => s.endRound === roundNum) ?? null;
}

/**
 * Get the current sprint for a given round.
 */
export function getCurrentSprint(
  roundNum: number,
  sprints: SprintContract[]
): SprintContract | null {
  return sprints.find((s) => roundNum >= s.startRound && roundNum <= s.endRound) ?? null;
}
