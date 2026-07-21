import type { ParsedCommand } from "../ai/interpreter.ts";
import type {
  ActionIntent,
  ActionKind,
  EntityKind,
  EntityReference,
  ResolvedActionIntent,
  ResolvedReference,
} from "../types/action-intent.ts";
import type { WorldState } from "../types/world.ts";

const VERB_KIND: Record<string, ActionKind> = {
  look: "observe",
  go: "navigate",
  interact: "interact",
  say: "communicate",
  attack: "combat",
  get: "inventory",
  drop: "inventory",
  equip: "inventory",
  use: "inventory",
  inv: "inventory",
  status: "inventory",
  objectives: "story_status",
  story_status: "story_status",
};

const TARGET_KINDS: Record<string, EntityKind[]> = {
  look: ["scene_object", "npc", "item", "room"],
  interact: ["scene_object", "item", "npc"],
  say: ["npc"],
  attack: ["npc", "scene_object"],
  get: ["item"],
  drop: ["item"],
  equip: ["item"],
  use: ["item", "scene_object"],
};

const CONTEXTUAL_WORDS = new Set([
  "它", "他", "她", "他们", "她们", "它们", "这个", "那个", "这些", "那些", "对方", "目标",
]);

function reference(text: string | undefined, role: EntityReference["role"], expectedKinds: EntityKind[]): EntityReference | undefined {
  const normalized = text?.trim();
  return normalized ? { text: normalized, role, expectedKinds } : undefined;
}

export function actionIntentFromParsed(parsed: ParsedCommand): ActionIntent {
  const args = parsed.args;
  const targetText = args.target ?? args.item;
  const target = reference(targetText, "target", TARGET_KINDS[parsed.verb] ?? ["scene_object", "npc", "item", "room"]);
  const tool = reference(args.weapon ?? args.tool, "tool", ["item"]);
  const destination = reference(args.destination ?? args.room, "destination", ["room"]);

  return {
    primaryKind: VERB_KIND[parsed.verb] ?? "unknown",
    goal: args.intent,
    approach: args.approach,
    questions: args.question ? [args.question] : [],
    constraints: args.constraints ? [args.constraints] : [],
    targets: target ? [target] : [],
    tools: tool ? [tool] : [],
    destination,
    direction: args.direction,
    raw: parsed.raw,
    confidence: parsed.confidence,
    legacy: { verb: parsed.verb, args: structuredClone(parsed.args) },
  };
}

interface Candidate {
  entityId: string;
  entityKind: EntityKind;
  name: string;
  aliases: string[];
  roomId?: string;
}

function candidatesFromState(state: WorldState): Candidate[] {
  const candidates: Candidate[] = [{
    entityId: state.player.id,
    entityKind: "player",
    name: state.player.name,
    aliases: ["我", "自己", "玩家"],
    roomId: state.player.roomId,
  }];
  for (const room of Object.values(state.rooms)) {
    candidates.push({ entityId: room.id, entityKind: "room", name: room.title, aliases: [], roomId: room.id });
  }
  for (const npc of Object.values(state.npcs)) {
    const aliases = (npc as typeof npc & { aliases?: string[] }).aliases ?? [];
    candidates.push({ entityId: npc.id, entityKind: "npc", name: npc.name, aliases, roomId: npc.roomId });
  }
  for (const item of Object.values(state.items)) {
    const roomId = item.location.kind === "room" ? item.location.roomId : undefined;
    candidates.push({ entityId: item.id, entityKind: "item", name: item.name, aliases: item.aliases ?? [], roomId });
  }
  return candidates;
}

function visibleCandidate(state: WorldState, candidate: Candidate, role: EntityReference["role"]): boolean {
  if (candidate.entityKind === "room") return true;
  if (candidate.entityKind === "player") return true;
  if (candidate.entityKind === "npc") return candidate.roomId === state.player.roomId;
  if (candidate.entityKind === "item") {
    const item = state.items[candidate.entityId];
    if (!item) return false;
    if (role === "tool") {
      return (item.location.kind === "inventory" || item.location.kind === "equipped")
        && item.location.ownerId === state.player.id;
    }
    return (item.location.kind === "room" && item.location.roomId === state.player.roomId)
      || ((item.location.kind === "inventory" || item.location.kind === "equipped") && item.location.ownerId === state.player.id);
  }
  return false;
}

function normalized(text: string): string {
  return text.trim()
    .replace(/^(所有|全部|这些|那些|这个|那个|这几个|那几个)/, "")
    .replace(/(们|一伙|一群)$/, "");
}

function resolveReference(state: WorldState, ref: EntityReference, all: Candidate[]): ResolvedReference {
  const allowed = all.filter((candidate) => ref.expectedKinds.includes(candidate.entityKind) && visibleCandidate(state, candidate, ref.role));
  const query = normalized(ref.text);
  const exact = allowed.filter((candidate) => candidate.entityId === ref.text || candidate.name === ref.text);
  if (exact.length === 1) return { ...ref, resolution: "exact", entityId: exact[0]!.entityId, entityKind: exact[0]!.entityKind };
  if (exact.length > 1) return ambiguous(ref, exact);

  const alias = allowed.filter((candidate) => candidate.aliases.some((value) => value === ref.text || value === query));
  if (alias.length === 1) return { ...ref, resolution: "alias", entityId: alias[0]!.entityId, entityKind: alias[0]!.entityKind };
  if (alias.length > 1) return ambiguous(ref, alias);

  const partial = query.length >= 2
    ? allowed.filter((candidate) => candidate.name.includes(query)
      || query.includes(candidate.name)
      || candidate.aliases.some((value) => value.includes(query) || query.includes(value)))
    : [];
  if (partial.length === 1) return { ...ref, resolution: "alias", entityId: partial[0]!.entityId, entityKind: partial[0]!.entityKind };
  if (partial.length > 1) return ambiguous(ref, partial);

  if (CONTEXTUAL_WORDS.has(ref.text)) {
    const local = allowed.filter((candidate) => candidate.entityKind !== "room");
    if (local.length === 1) return { ...ref, resolution: "contextual", entityId: local[0]!.entityId, entityKind: local[0]!.entityKind };
    if (local.length > 1) return ambiguous(ref, local);
  }

  return { ...ref, resolution: "missing" };
}

function ambiguous(ref: EntityReference, candidates: Candidate[]): ResolvedReference {
  return {
    ...ref,
    resolution: "ambiguous",
    candidates: candidates.map(({ entityId, entityKind, name }) => ({ entityId, entityKind, name })),
  };
}

export function resolveActionIntent(state: WorldState, intent: ActionIntent): ResolvedActionIntent {
  const all = candidatesFromState(state);
  const resolvedTargets = intent.targets.map((ref) => resolveReference(state, ref, all));
  const resolvedTools = intent.tools.map((ref) => resolveReference(state, ref, all));
  const resolvedDestination = intent.destination ? resolveReference(state, intent.destination, all) : undefined;
  const references = [...resolvedTargets, ...resolvedTools, ...(resolvedDestination ? [resolvedDestination] : [])];
  const unresolved = references.some((ref) => ref.resolution === "missing"
    || ref.resolution === "ambiguous"
    || ref.resolution === "narrated_unregistered");

  return {
    ...intent,
    resolvedTargets,
    resolvedTools,
    resolvedDestination,
    requiresSemanticAdjudication: intent.primaryKind === "interact"
      || intent.primaryKind === "story_status"
      || intent.primaryKind === "unknown"
      || unresolved,
  };
}
