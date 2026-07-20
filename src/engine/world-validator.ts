// ─────────────────────────────────────────────────────────────
// world-validator.ts — validate world pack references before runtime
// ─────────────────────────────────────────────────────────────

import type {
  EndingRule,
  NpcController,
  NpcPersona,
  ObjectiveDef,
  ProtagonistProfile,
  StatsSchema,
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
    stats?: Record<string, number>;
  }>;
  items: Array<{ id: string; inRoom?: string; inInventory?: boolean }>;
  objectives?: ObjectiveDef[];
  endings?: EndingRule[];
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

  const endingIds = new Set<string>();
  for (const ending of pack.endings ?? []) {
    if (!ending.id) errors.push("endings contains an ending with empty id");
    if (endingIds.has(ending.id)) errors.push(`duplicate ending id: ${ending.id}`);
    endingIds.add(ending.id);
    for (const condition of ending.conditions ?? []) {
      if (condition.kind === "objective_completed" && !objectiveIds.has(condition.objectiveId)) {
        errors.push(`ending ${ending.id} references missing objective: ${condition.objectiveId}`);
      }
      if (condition.kind === "item_owned" && !itemIds.has(condition.itemId)) {
        errors.push(`ending ${ending.id} references missing item: ${condition.itemId}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid world pack ${label}:\n- ${errors.join("\n- ")}`);
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
