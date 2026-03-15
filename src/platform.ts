export const PLATFORM_ACTIONS = [
  "post",
  "comment",
  "repost",
  "quote",
  "like",
  "unlike",
  "follow",
  "unfollow",
  "mute",
  "block",
  "report",
  "delete",
  "search",
  "idle",
] as const;

export type PlatformAction = (typeof PLATFORM_ACTIONS)[number];
export type PlatformTier = "A" | "B" | "C";
export type FeedAlgorithm =
  | "chronological"
  | "heuristic"
  | "trace-aware"
  | "embedding"
  | "hybrid";

export interface PlatformFeatures {
  upvoteDownvote: boolean;
  threads: boolean;
  characterLimit: number;
  anonymousPosting: boolean;
  communitiesUserCreated: boolean;
}

export interface PlatformModerationConfig {
  enabled: boolean;
  reportThreshold: number;
  shadowBanOnThreshold: boolean;
}

export interface PlatformPolicyConfig {
  name: string;
  features: PlatformFeatures;
  actions: PlatformAction[];
  recsys: FeedAlgorithm;
  tierAllowedActions: Record<PlatformTier, PlatformAction[]>;
  moderation: PlatformModerationConfig;
}

export const DEFAULT_PLATFORM_POLICY: PlatformPolicyConfig = {
  name: "x",
  features: {
    upvoteDownvote: false,
    threads: false,
    characterLimit: 280,
    anonymousPosting: false,
    communitiesUserCreated: false,
  },
  actions: [
    "post",
    "comment",
    "repost",
    "quote",
    "like",
    "unlike",
    "follow",
    "unfollow",
    "mute",
    "block",
    "report",
    "delete",
    "search",
    "idle",
  ],
  recsys: "hybrid",
  tierAllowedActions: {
    A: [
      "post",
      "comment",
      "repost",
      "quote",
      "like",
      "unlike",
      "follow",
      "unfollow",
      "mute",
      "block",
      "report",
      "delete",
      "search",
      "idle",
    ],
    B: [
      "post",
      "comment",
      "repost",
      "quote",
      "like",
      "unlike",
      "follow",
      "unfollow",
      "mute",
      "report",
      "delete",
      "search",
      "idle",
    ],
    C: [
      "post",
      "comment",
      "repost",
      "like",
      "follow",
      "unfollow",
      "idle",
    ],
  },
  moderation: {
    enabled: true,
    reportThreshold: 3,
    shadowBanOnThreshold: true,
  },
};

export function getAllowedActionsForTier(
  policy: PlatformPolicyConfig,
  tier: PlatformTier,
  opts?: { includeSearch?: boolean }
): PlatformAction[] {
  const allowed = policy.tierAllowedActions[tier].filter((action) =>
    policy.actions.includes(action)
  );
  return opts?.includeSearch ? allowed : allowed.filter((action) => action !== "search");
}

export function isKnownPlatformAction(action: string): action is PlatformAction {
  return (PLATFORM_ACTIONS as readonly string[]).includes(action);
}

export function isActionAllowedForTier(
  policy: PlatformPolicyConfig,
  tier: PlatformTier,
  action: string,
  opts?: { includeSearch?: boolean }
): action is PlatformAction {
  return getAllowedActionsForTier(policy, tier, opts).includes(action as PlatformAction);
}

