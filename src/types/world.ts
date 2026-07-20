// ─────────────────────────────────────────────────────────────
// World State — the canonical snapshot stored in state.json
// ─────────────────────────────────────────────────────────────

export type RoomSource = "static" | "procedural" | "dm_generated";

export type ProceduralRoomRole = "entrance" | "transit" | "boss" | "treasure" | "special";

export interface WorldGenerationState {
  seed: string;
  generatorVersion: string;
  targetRoomCount: number;
  generatedRoomIds: string[];
  roomRoles: Record<string, ProceduralRoomRole>;
  mstEdges: number;
  loopEdges: number;
}

// ── Stats Schema (defined in world.json, drives all attribute behavior) ────

export type StatDisplayStyle = "bar" | "number" | "hidden";
export interface ParameterThreshold {
  operator: "lte" | "gte";
  value: number;
  effect: { kind: "set_lifecycle"; value: PlayerLifecycle };
}

export interface StatDef {
  key: string;            // world-defined parameter id; Engine assigns no semantic meaning
  label: string;
  description?: string;
  min: number;
  max: number;
  default: number;
  display: StatDisplayStyle;
  thresholds?: ParameterThreshold[];
}

export interface StatsSchema {
  defs: StatDef[];
}

export type ConflictRules =
  | {
      mode: "auto_combat";
      algorithm: "gauge-random-v1";
      baseHitChance?: number;
      minHitChance?: number;
      maxHitChance?: number;
      accuracyScale?: number;
      luckHitScale?: number;
      baseCritChance?: number;
      luckCritScale?: number;
      maxCritChance?: number;
      normalDamageMin?: number;
      normalDamageMax?: number;
      parameters?: {
        pool: string;
        attack: string;
        defense?: string;
        speed?: string;
        luck?: string;
        accuracy?: string;
        evasion?: string;
      };
      critMultiplier?: number;
      likelyFailureWarning?: string;
      dangerousWarning?: string;
    }
  | {
      mode: "dice_check";
      dice?: { count: number; sides: number };
      criticalSuccess?: "all_max";
      criticalFailure?: "all_min";
    }
  | { mode: "none" };

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
  discovered: boolean;
  visitedTurn?: number;
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

export type ItemKind = "item" | "equipment" | "key" | "scenery";

export interface ParameterModifier {
  parameterId: string;
  operation: "add" | "rate";
  value: number;
}

export interface DataTrait {
  code: string;
  dataId?: string;
  value: number;
}

export interface ItemEffect {
  code: string;
  parameterId?: string;
  value?: number;
  rate?: number;
  dice?: { count: number; sides: number };
  stateId?: string;
}

export interface ItemDef {
  id: string;
  name: string;
  desc: string;
  kind?: ItemKind;
  equipSlot?: string;
  parameterModifiers?: ParameterModifier[];
  traits?: DataTrait[];
  effects?: ItemEffect[];
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
  conflictRules?: ConflictRules; // data consumed by the selected world conflict script
  conflictScript?: string;
  conflictOptions?: Record<string, unknown>;
  player: PlayerState;
  rooms: Record<string, RoomDef>;
  npcs: Record<string, NpcDef>;
  items: Record<string, ItemDef>;
  plotThreads: Record<string, PlotThread>;
  worldFacts: WorldFact[];
  objectives: Record<string, ObjectiveState>;
  generation?: WorldGenerationState;
  outcome?: ReachedOutcome;
}
