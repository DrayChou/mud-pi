// ─────────────────────────────────────────────────────────────
// world-validator.ts — validate world pack references before runtime
// ─────────────────────────────────────────────────────────────

import { PROCEDURAL_MAP_VERSION, type ProceduralMapConfig } from "./procedural-map.ts";
import type {
  ConflictRules,
  DataTrait,
  ItemEffect,
  ItemKind,
  NpcController,
  ParameterModifier,
  NpcPersona,
  NpcStoryRole,
  ObjectiveDef,
  ProtagonistProfile,
  StatsSchema,
  StoryOutcomeDef,
} from "../types/world.ts";

export interface WorldPackForValidation {
  name: string;
  bornPoint: string;
  schema: StatsSchema;
  playerStats?: Record<string, number>;
  defaultProtagonistId?: string;
  protagonists?: ProtagonistProfile[];
  rooms: Array<{ id: string; exits: Record<string, string>; tags?: string[] }>;
  npcs: Array<{
    id: string;
    roomId: string;
    controller?: NpcController;
    persona?: NpcPersona;
    storyRole?: NpcStoryRole;
    stats?: Record<string, number>;
  }>;
  items: Array<{
    id: string;
    inRoom?: string;
    inInventory?: boolean;
    kind?: ItemKind;
    equipSlot?: string;
    parameterModifiers?: ParameterModifier[];
    traits?: DataTrait[];
    effects?: ItemEffect[];
  }>;
  objectives?: ObjectiveDef[];
  outcomes?: StoryOutcomeDef[];
  proceduralMap?: ProceduralMapConfig;
  conflictRules?: ConflictRules;
}

export function validateWorldPack(pack: WorldPackForValidation, label = pack.name): void {
  const errors: string[] = [];

  const statKeys = new Set<string>();
  for (const def of pack.schema.defs ?? []) {
    if (!def.key) errors.push("schema.defs contains a stat with empty key");
    if (statKeys.has(def.key)) errors.push(`duplicate stat key: ${def.key}`);
    statKeys.add(def.key);
    if (def.min > def.max) errors.push(`stat ${def.key} has min > max`);
    if (def.default < def.min || def.default > def.max) {
      errors.push(`stat ${def.key} default ${def.default} is outside ${def.min}-${def.max}`);
    }
    for (const threshold of def.thresholds ?? []) {
      if (!Number.isFinite(threshold.value)) errors.push(`stat ${def.key} threshold value must be finite`);
      if (threshold.effect.kind !== "set_lifecycle" || !["active", "incapacitated", "dead"].includes(threshold.effect.value)) {
        errors.push(`stat ${def.key} has invalid threshold effect`);
      }
    }
  }

  validateStats("playerStats", pack.playerStats, pack.schema, statKeys, errors);

  const roomIds = new Set<string>();
  for (const room of pack.rooms ?? []) {
    if (!room.id) errors.push("rooms contains a room with empty id");
    if (roomIds.has(room.id)) errors.push(`duplicate room id: ${room.id}`);
    roomIds.add(room.id);
  }

  if (!roomIds.has(pack.bornPoint)) {
    errors.push(`bornPoint references missing room: ${pack.bornPoint}`);
  }

  if (pack.conflictRules) validateConflictRules(pack.conflictRules, statKeys, errors);

  if (pack.proceduralMap) {
    const config = pack.proceduralMap;
    if (config.generator !== PROCEDURAL_MAP_VERSION) {
      errors.push(`proceduralMap has unsupported generator: ${config.generator}`);
    }
    if (!roomIds.has(config.attachTo)) {
      errors.push(`proceduralMap.attachTo references missing room: ${config.attachTo}`);
    }
    if (!Number.isInteger(config.totalRooms.min) || !Number.isInteger(config.totalRooms.max)) {
      errors.push("proceduralMap.totalRooms min/max must be integers");
    } else {
      if (config.totalRooms.min < roomIds.size) {
        errors.push("proceduralMap.totalRooms.min cannot be smaller than static room count");
      }
      if (config.totalRooms.max < config.totalRooms.min || config.totalRooms.max > 64) {
        errors.push("proceduralMap.totalRooms.max must be between min and 64");
      }
    }
    if (config.loopChance < 0 || config.loopChance > 1) {
      errors.push("proceduralMap.loopChance must be between 0 and 1");
    }
    if (!config.templates?.length) errors.push("proceduralMap requires room templates");
    for (const [index, template] of (config.templates ?? []).entries()) {
      if (!template.title?.trim() || !template.desc?.trim()) {
        errors.push(`proceduralMap template ${index} requires title and desc`);
      }
    }
  }

  for (const room of pack.rooms ?? []) {
    for (const [direction, toRoomId] of Object.entries(room.exits ?? {})) {
      if (!roomIds.has(toRoomId)) {
        errors.push(`room ${room.id} exit ${direction} references missing room: ${toRoomId}`);
      }
    }
  }

  const itemIds = new Set<string>();
  for (const item of pack.items ?? []) {
    if (!item.id) errors.push("items contains an item with empty id");
    if (itemIds.has(item.id)) errors.push(`duplicate item id: ${item.id}`);
    itemIds.add(item.id);
    if (item.inRoom && !roomIds.has(item.inRoom)) {
      errors.push(`item ${item.id} inRoom references missing room: ${item.inRoom}`);
    }
    if (item.kind === "equipment" && !item.equipSlot?.trim()) {
      errors.push(`equipment ${item.id} requires equipSlot`);
    }
    if (item.kind !== "equipment" && item.equipSlot) {
      errors.push(`non-equipment ${item.id} cannot declare equipSlot`);
    }
    for (const modifier of item.parameterModifiers ?? []) {
      if (!statKeys.has(modifier.parameterId)) {
        errors.push(`item ${item.id} modifier references missing parameter: ${modifier.parameterId}`);
      }
      if (!Number.isFinite(modifier.value)) errors.push(`item ${item.id} modifier value must be finite`);
      if (modifier.operation === "rate" && modifier.value < 0) {
        errors.push(`item ${item.id} parameter rate cannot be negative`);
      }
    }
    for (const effect of item.effects ?? []) {
      if (effect.parameterId && !statKeys.has(effect.parameterId)) {
        errors.push(`item ${item.id} effect references missing parameter: ${effect.parameterId}`);
      }
    }
  }

  const npcIds = new Set<string>();
  for (const npc of pack.npcs ?? []) {
    if (!npc.id) errors.push("npcs contains an npc with empty id");
    if (npcIds.has(npc.id)) errors.push(`duplicate npc id: ${npc.id}`);
    npcIds.add(npc.id);
    if (!roomIds.has(npc.roomId)) {
      errors.push(`npc ${npc.id} roomId references missing room: ${npc.roomId}`);
    }
    if (npc.controller && !["dm", "pi_session", "rule"].includes(npc.controller)) {
      errors.push(`npc ${npc.id} has invalid controller: ${npc.controller}`);
    }
    if (npc.controller === "pi_session" && !npc.persona) {
      errors.push(`npc ${npc.id} uses pi_session but has no persona`);
    }
    if (npc.storyRole) {
      if (!["ambient", "supporting", "critical"].includes(npc.storyRole.importance)) {
        errors.push(`npc ${npc.id} has invalid story importance: ${npc.storyRole.importance}`);
      }
      if (npc.storyRole.deathPolicy && !["continue", "ai_evaluate", "immediate_outcome"].includes(npc.storyRole.deathPolicy)) {
        errors.push(`npc ${npc.id} has invalid deathPolicy: ${npc.storyRole.deathPolicy}`);
      }
    }
    validateStats(`npc ${npc.id} stats`, npc.stats, pack.schema, statKeys, errors);
  }

  const protagonistIds = new Set<string>();
  for (const protagonist of pack.protagonists ?? []) {
    if (!protagonist.id) errors.push("protagonists contains a protagonist with empty id");
    if (protagonistIds.has(protagonist.id)) {
      errors.push(`duplicate protagonist id: ${protagonist.id}`);
    }
    protagonistIds.add(protagonist.id);

    validateStats(
      `protagonist ${protagonist.id} initialStats`,
      protagonist.initialStats,
      pack.schema,
      statKeys,
      errors
    );

    for (const itemId of protagonist.initialInventory ?? []) {
      if (!itemIds.has(itemId)) {
        errors.push(`protagonist ${protagonist.id} initialInventory references missing item: ${itemId}`);
      }
    }
  }

  if (pack.defaultProtagonistId && !protagonistIds.has(pack.defaultProtagonistId)) {
    errors.push(`defaultProtagonistId references missing protagonist: ${pack.defaultProtagonistId}`);
  }

  const objectiveIds = new Set<string>();
  for (const objective of pack.objectives ?? []) {
    if (!objective.id) errors.push("objectives contains an objective with empty id");
    if (objectiveIds.has(objective.id)) errors.push(`duplicate objective id: ${objective.id}`);
    objectiveIds.add(objective.id);
  }
  for (const objective of pack.objectives ?? []) {
    for (const requiredId of objective.requires ?? []) {
      if (!objectiveIds.has(requiredId)) {
        errors.push(`objective ${objective.id} requires missing objective: ${requiredId}`);
      }
    }
    const completion = objective.completion;
    if (completion.kind === "visit_room" && !roomIds.has(completion.roomId)) {
      errors.push(`objective ${objective.id} references missing room: ${completion.roomId}`);
    }
    if (completion.kind === "talk_to_npc" && !npcIds.has(completion.npcId)) {
      errors.push(`objective ${objective.id} references missing npc: ${completion.npcId}`);
    }
    if (completion.kind === "acquire_item" && !itemIds.has(completion.itemId)) {
      errors.push(`objective ${objective.id} references missing item: ${completion.itemId}`);
    }
    if (completion.kind === "defeat_entity" && !npcIds.has(completion.entityId)) {
      errors.push(`objective ${objective.id} references missing entity: ${completion.entityId}`);
    }
  }

  const outcomeIds = new Set<string>();
  const outcomeTypes = new Set(["success", "failure", "death", "transformation", "abandonment", "softlock", "custom"]);
  for (const outcome of pack.outcomes ?? []) {
    if (!outcome.id) errors.push("outcomes contains an outcome with empty id");
    if (outcomeIds.has(outcome.id)) errors.push(`duplicate outcome id: ${outcome.id}`);
    outcomeIds.add(outcome.id);
    if (!outcomeTypes.has(outcome.type)) errors.push(`outcome ${outcome.id} has invalid type: ${outcome.type}`);
    if (!outcome.criteria?.trim()) errors.push(`outcome ${outcome.id} has empty criteria`);
    if (typeof outcome.terminal !== "boolean") errors.push(`outcome ${outcome.id} terminal must be boolean`);
  }

  if (errors.length > 0) {
    throw new Error(`Invalid world pack ${label}:\n- ${errors.join("\n- ")}`);
  }
}

function validateConflictRules(rules: ConflictRules, statKeys: Set<string>, errors: string[]): void {
  if (rules.mode === "auto_combat") {
    if (rules.algorithm !== "gauge-random-v1") errors.push(`unsupported combat algorithm: ${rules.algorithm}`);
    for (const [binding, parameterId] of Object.entries(rules.parameters ?? {})) {
      if (!statKeys.has(parameterId)) {
        errors.push(`conflictRules parameter ${binding} references missing parameter: ${parameterId}`);
      }
    }
    const probabilities = [
      ["baseHitChance", rules.baseHitChance], ["minHitChance", rules.minHitChance],
      ["maxHitChance", rules.maxHitChance], ["baseCritChance", rules.baseCritChance],
      ["maxCritChance", rules.maxCritChance],
    ] as const;
    for (const [name, value] of probabilities) {
      if (value !== undefined && (value < 0 || value > 1)) errors.push(`conflictRules.${name} must be between 0 and 1`);
    }
    if (rules.normalDamageMin !== undefined && rules.normalDamageMin < 0) {
      errors.push("conflictRules.normalDamageMin cannot be negative");
    }
    if (
      rules.normalDamageMin !== undefined && rules.normalDamageMax !== undefined &&
      rules.normalDamageMax < rules.normalDamageMin
    ) errors.push("conflictRules normalDamageMax cannot be smaller than normalDamageMin");
    if (rules.critMultiplier !== undefined && rules.critMultiplier < 1) {
      errors.push("conflictRules.critMultiplier must be at least 1");
    }
  } else if (rules.mode === "dice_check" && rules.dice) {
    if (!Number.isInteger(rules.dice.count) || rules.dice.count < 1 || !Number.isInteger(rules.dice.sides) || rules.dice.sides < 2) {
      errors.push("conflictRules.dice requires positive count and at least two sides");
    }
  }
}

function validateStats(
  label: string,
  stats: Record<string, number> | undefined,
  schema: StatsSchema,
  statKeys: Set<string>,
  errors: string[]
): void {
  if (!stats) return;

  const defs = new Map(schema.defs.map((def) => [def.key, def]));
  const maxKeys = new Map(schema.defs.map((def) => [`${def.key}Max`, def]));

  for (const [key, value] of Object.entries(stats)) {
    if (typeof value !== "number" || Number.isNaN(value)) {
      errors.push(`${label}.${key} must be a number`);
      continue;
    }

    const maxDef = maxKeys.get(key);
    if (maxDef) {
      if (value < maxDef.min) {
        errors.push(`${label}.${key} ${value} is below minimum ${maxDef.min}`);
      }
      continue;
    }

    if (!statKeys.has(key)) {
      errors.push(`${label} contains unknown stat key: ${key}`);
      continue;
    }

    const def = defs.get(key)!;
    const maxOverride = stats[`${key}Max`];
    const max = typeof maxOverride === "number" && !Number.isNaN(maxOverride)
      ? maxOverride
      : def.max;
    if (value < def.min || value > max) {
      errors.push(`${label}.${key} ${value} is outside ${def.min}-${max}`);
    }
  }
}
