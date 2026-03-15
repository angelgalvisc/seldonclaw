import type { GraphStore } from "./db.js";
import type { PlatformModerationConfig } from "./platform.js";

export interface ModerationDecision {
  postId: string;
  status: "none" | "flagged" | "shadowed";
  reportCount: number;
}

export function applyAutomaticModeration(
  store: GraphStore,
  runId: string,
  roundNum: number,
  config: PlatformModerationConfig
): ModerationDecision[] {
  if (!config.enabled) return [];

  const decisions: ModerationDecision[] = [];
  for (const postId of store.getReportedPostIdsForRound(runId, roundNum)) {
    const reportCount = store.countReportsForPost(postId, runId);
    if (reportCount >= config.reportThreshold) {
      const status = config.shadowBanOnThreshold ? "shadowed" : "flagged";
      store.setPostModerationStatus(postId, status);
      decisions.push({ postId, status, reportCount });
    } else {
      decisions.push({ postId, status: "none", reportCount });
    }
  }
  return decisions;
}
