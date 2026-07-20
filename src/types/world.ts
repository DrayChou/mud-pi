// ─────────────────────────────────────────────────────────────
// World State — the canonical snapshot stored in state.json
// ─────────────────────────────────────────────────────────────

export type RoomSource = "static" | "dm_generated";

// ── Stats Schema (defined in world.json, drives all attribute behavior) ────

export type StatDisplayStyle = "bar" | "number" | "hidden";
export type StatLossEffect =
  | "death"      // reach 0 → player/NPC dies
  | "incapacitate" // reach 0 → unable to act
  | "narrative"; // reach 0 → DM decides what happens (no engine effect)

export interface StatDef {
  key: string;            // internal key, e.g. "hp", "san", "mp"
  label: string;          // display name, e.g. "生命", "理智", "法力"
  min: number;            // usually 0
  max: number;            // default max, overridable per-entity
  default: number;        // starting value
  display: StatDisplayStyle;
  onDeplete: StatLossEffect;
  // For combat: which stat the entity uses to deal/receive damage
  // "attack" stat contributes to outgoing damage
  // "defense" stat reduces incoming damage
  role?: "pool" | "attack" | "defense";
}

export interface StatsSchema {
  defs: StatDef[];
}

// ── Runtime stat bag — key → current value ────────────────────────────────

export type Stats = Record<string, number>;

// Helper: build a Stats object from defaults in the schema
export function defaultStats(schema: StatsSchema): Stats {
  const s: Stats = {};
  for (const def of schema.defs) {
    s[def.key] = def.default;
  }
  return s;
}

export function maxStats(schema: StatsSchema): Stats {
  const s: Stats = {};
  for (const def of schema.defs) {
    s[`${def.key}Max`] = def.max;
  }
  return s;
}

// ── Entity definitions ─────────────────────────────────────────────────────

export interface RoomDef {
  id: string;
  title: string;
  desc: string;
  exits: Record<string, string>;
  source: RoomSource;
  createdTurn?: number;
  tags?: string[];
}

export type NpcController = "dm" | "pi_session" | "rule";

export interface NpcPersona {
  background?: string;
  speechStyle?: string;
  goals?: string[];
  constraints?: string[];
}

export interface NpcStoryRole {
  importance: "ambient" | "supporting" | "critical";
  deathPolicy?: "continue" | "ai_evaluate" | "immediate_outcome";
  notes?: string;
}

export interface NpcDef {
  id: string;
  name: string;
  roomId: string;
  alive: boolean;
  personality: string;
  controller?: NpcController; // old saves default to "dm"
  persona?: NpcPersona;
  storyRole?: NpcStoryRole;
  source: RoomSource;
  stats: Stats;       // e.g. { hp: 30, attack: 8, defense: 2 }
  maxStats: Stats;    // e.g. { hpMax: 30 }
  hostile: boolean;
}

export type ItemLocation =
  | { kind: "room"; roomId: string }
  | { kind: "inventory"; ownerId: string }
  | { kind: "equipped"; ownerId: string; slot: string }
  | { kind: "destroyed" };

export interface ItemDef {
  id: string;
  name: string;
  desc: string;
  aliases?: string[];
  location: ItemLocation;
  portable?: boolean; // defaults to true; false means scenery that can be examined but not carried
  source?: RoomSource;
  createdTurn?: number;
}

export type PlotStatus = "active" | "resolved" | "dormant";

export interface PlotThread {
  id: string;
  title: string;
  status: PlotStatus;
  summary: string;
  updatedTurn: number;
}

export interface WorldFact {
  text: string;
  tile: string | null;
  createdTurn: number;
}

export type ObjectiveCompletion =
  | { kind: "visit_room"; roomId: string }
  | { kind: "talk_to_npc"; npcId: string }
  | { kind: "acquire_item"; itemId: string }
  | { kind: "defeat_entity"; entityId: string };

export interface ObjectiveDef {
  id: string;
  title: string;
  description: string;
  requires?: string[];
  hidden?: boolean;
  completion: ObjectiveCompletion;
}

export type ObjectiveStatus = "active" | "completed";

export interface ObjectiveState extends ObjectiveDef {
  status: ObjectiveStatus;
  completedTurn?: number;
}

export type StoryOutcomeType =
  | "success"
  | "failure"
  | "death"
  | "transformation"
  | "abandonment"
  | "softlock"
  | "custom";

export interface StoryOutcomeDef {
  id: string;
  type: StoryOutcomeType;
  title: string;
  summary: string;
  criteria: string; // world-pack guidance evaluated by the DM, never hardcoded in Engine
  terminal: boolean;
}

export interface ReachedOutcome {
  id: string;
  type: StoryOutcomeType;
  title: string;
  summary: string;
  terminal: boolean;
  reachedTurn: number;
  reason?: string;
}

export interface ProtagonistProfile {
  id: string;
  name: string;
  summary: string;
  background: string;
  motivation: string;
  initialStats?: Stats;
  initialInventory?: string[];
  openingHook?: string;
}

export type PlayerLifecycle = "active" | "incapacitated" | "dead";

export interface PlayerState {
  id: string;
  name: string;
  roomId: string;
  lifecycle: PlayerLifecycle;
  stats: Stats;       // e.g. { hp: 85, mp: 40, san: 60 }
  maxStats: Stats;    // e.g. { hpMax: 100, mpMax: 50, sanMax: 100 }
  profile?: ProtagonistProfile; // snapshot from world pack at save creation
  inventory: string[];
  equipment: Record<string, string>;
}

export interface WorldState {
  worldId: string;
  worldPack: string;
  turn: number;
  schema: StatsSchema; // loaded from world.json, stays constant
  player: PlayerState;
  rooms: Record<string, RoomDef>;
  npcs: Record<string, NpcDef>;
  items: Record<string, ItemDef>;
  plotThreads: Record<string, PlotThread>;
  worldFacts: WorldFact[];
  objectives: Record<string, ObjectiveState>;
  outcome?: ReachedOutcome;
}
