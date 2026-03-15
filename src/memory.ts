/**
 * memory.ts — Deliberative actor memory between rounds
 *
 * Persists short, auditable memories for Tier A/B actors:
 * - reflections on why they acted
 * - salient interactions from the feed
 * - active events touching their interests
 * - narrative shifts on topics they care about
 */

import type { GraphStore, NarrativeRow, SimEvent, ActorMemoryRow } from "./db.js";
import { stableId } from "./db.js";
import type { ScheduledActorAction } from "./scheduler.js";

export function persistActorMemories(
  store: GraphStore,
  runId: string,
  roundNum: number,
  actions: ScheduledActorAction[],
  activeEvents: SimEvent[],
  narratives: NarrativeRow[]
): number {
  let inserted = 0;

  for (const action of actions) {
    if (action.route.tier === "C") continue;

    const memories = deriveActorMemories(runId, roundNum, action, activeEvents, narratives);
    for (const memory of memories) {
      store.addActorMemory(memory);
      inserted++;
    }
  }

  return inserted;
}

export function deriveActorMemories(
  runId: string,
  roundNum: number,
  action: ScheduledActorAction,
  activeEvents: SimEvent[],
  narratives: NarrativeRow[]
): ActorMemoryRow[] {
  const memories: ActorMemoryRow[] = [];
  const actorTopicSet = new Set(action.actorTopics);

  if (action.decision.action !== "idle" || action.decision.reasoning) {
    memories.push({
      id: stableId("memory", runId, action.actor.id, String(roundNum), "reflection"),
      run_id: runId,
      actor_id: action.actor.id,
      round_num: roundNum,
      kind: "reflection",
      summary: summarizeReflection(action),
      salience: action.route.tier === "A" ? 0.95 : 0.75,
      topic: action.actorTopics[0] ?? null,
    });
  }

  const topFeed = action.feed[0];
  if (topFeed) {
    memories.push({
      id: stableId("memory", runId, action.actor.id, String(roundNum), "interaction", topFeed.post.id),
      run_id: runId,
      actor_id: action.actor.id,
      round_num: roundNum,
      kind: "interaction",
      summary: summarizeInteraction(action.actor.name, topFeed.post.authorId, topFeed.post.content),
      salience: Math.min(0.9, 0.35 + topFeed.score * 0.5),
      topic: topFeed.post.topics[0] ?? null,
      source_post_id: topFeed.post.id,
      source_actor_id: topFeed.post.authorId,
    });
  }

  for (const event of activeEvents) {
    if (!event.topics.some((topic) => actorTopicSet.has(topic))) continue;
    memories.push({
      id: stableId("memory", runId, action.actor.id, String(roundNum), "event", event.type, event.content),
      run_id: runId,
      actor_id: action.actor.id,
      round_num: roundNum,
      kind: "event",
      summary: summarizeEvent(event),
      salience: 0.9,
      topic: event.topics[0] ?? null,
      source_actor_id: event.actor_id ?? null,
    });
    break;
  }

  const dominantNarrative = narratives
    .filter((n) => actorTopicSet.has(n.topic))
    .sort((a, b) => b.current_intensity - a.current_intensity)[0];
  if (dominantNarrative) {
    memories.push({
      id: stableId("memory", runId, action.actor.id, String(roundNum), "narrative", dominantNarrative.topic),
      run_id: runId,
      actor_id: action.actor.id,
      round_num: roundNum,
      kind: "narrative",
      summary: summarizeNarrative(dominantNarrative),
      salience: Math.min(0.85, 0.3 + dominantNarrative.current_intensity * 0.5),
      topic: dominantNarrative.topic,
    });
  }

  return dedupeAndTrim(memories, 4);
}

function summarizeReflection(action: ScheduledActorAction): string {
  const reason = action.decision.reasoning?.trim();
  if (reason) {
    return reason.length > 180 ? reason.slice(0, 177) + "..." : reason;
  }

  switch (action.decision.action) {
    case "post":
      return `You decided to publish a new post this round.`;
    case "comment":
      return `You decided to comment on another actor's post this round.`;
    case "repost":
      return `You decided to amplify a post that felt important to your audience.`;
    case "quote":
      return `You amplified a post while adding your own framing to it.`;
    case "like":
      return `You endorsed a post that aligned with your current beliefs.`;
    case "unlike":
      return `You withdrew a prior endorsement from a post that no longer fit your position.`;
    case "follow":
      return `You started following an actor who seems relevant to your interests.`;
    case "unfollow":
      return `You stopped following an actor whose content no longer served your goals.`;
    case "mute":
      return `You muted an actor to reduce unwanted content in your feed.`;
    case "block":
      return `You blocked an actor to cut off direct visibility and interaction.`;
    case "report":
      return `You reported a post to the platform for moderation review.`;
    case "delete":
      return `You removed one of your own posts from the platform.`;
    default:
      return `You stayed silent this round.`;
  }
}

function summarizeInteraction(actorName: string, sourceActorId: string, content: string): string {
  const snippet = content.length > 90 ? content.slice(0, 87) + "..." : content;
  return `${actorName} focused on a post from ${sourceActorId}: "${snippet}"`;
}

function summarizeEvent(event: SimEvent): string {
  const snippet = event.content.length > 100 ? event.content.slice(0, 97) + "..." : event.content;
  return `An active ${event.type.replaceAll("_", " ")} shaped the round: "${snippet}"`;
}

function summarizeNarrative(narrative: NarrativeRow): string {
  const sentiment = narrative.dominant_sentiment >= 0 ? "supportive" : "critical";
  return `The ${narrative.topic} narrative remained ${sentiment} with intensity ${narrative.current_intensity.toFixed(2)}.`;
}

function dedupeAndTrim(memories: ActorMemoryRow[], limit: number): ActorMemoryRow[] {
  const deduped = new Map<string, ActorMemoryRow>();
  for (const memory of memories) {
    const key = [memory.kind, memory.topic ?? "", memory.source_post_id ?? "", memory.summary].join("|");
    const existing = deduped.get(key);
    if (!existing || existing.salience < memory.salience) {
      deduped.set(key, memory);
    }
  }
  return [...deduped.values()]
    .sort((a, b) => b.salience - a.salience)
    .slice(0, limit);
}
