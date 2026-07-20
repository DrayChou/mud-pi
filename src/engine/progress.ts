import type { GameEvent } from "../types/events.ts";
import type { EngineMutation } from "../types/mutations.ts";
import type { EndingCondition, ObjectiveState, WorldState } from "../types/world.ts";

/** Evaluate objective and ending rules without mutating state. */
export function evaluateProgress(state: WorldState, events: GameEvent[]): EngineMutation[] {
  if (state.ending) return [];

  const completed = new Set(
    Object.values(state.objectives)
      .filter((objective) => objective.status === "completed")
      .map((objective) => objective.id)
  );
  const mutations: EngineMutation[] = [];

  // Dependencies may form a chain completed by the same batch of events.
  let changed = true;
  while (changed) {
    changed = false;
    for (const objective of Object.values(state.objectives)) {
      if (completed.has(objective.id)) continue;
      if (!(objective.requires ?? []).every((id) => completed.has(id))) continue;
      if (!objectiveMatches(objective, state, events)) continue;
      completed.add(objective.id);
      mutations.push({ kind: "engine/objective_completed", objectiveId: objective.id });
      changed = true;
    }
  }

  const ending = [...state.endingRules]
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .find((rule) => rule.conditions.every((condition) => endingConditionMatches(condition, state, completed)));
  if (ending) mutations.push({ kind: "engine/ending_reached", endingId: ending.id });

  return mutations;
}

function objectiveMatches(
  objective: ObjectiveState,
  state: WorldState,
  events: GameEvent[]
): boolean {
  const completion = objective.completion;
  switch (completion.kind) {
    case "visit_room":
      return state.player.roomId === completion.roomId || events.some(
        (event) => event.kind === "player_moved" && event.toRoomId === completion.roomId
      );
    case "talk_to_npc":
      return events.some(
        (event) => event.kind === "player_spoke" && event.targetId === completion.npcId
      );
    case "acquire_item": {
      const item = state.items[completion.itemId];
      return Boolean(
        item &&
        (item.location.kind === "inventory" || item.location.kind === "equipped") &&
        item.location.ownerId === state.player.id
      );
    }
    case "defeat_entity":
      return state.npcs[completion.entityId]?.alive === false || events.some(
        (event) => event.kind === "entity_defeated" && event.entityId === completion.entityId
      );
  }
}

function endingConditionMatches(
  condition: EndingCondition,
  state: WorldState,
  completed: Set<string>
): boolean {
  switch (condition.kind) {
    case "objective_completed":
      return completed.has(condition.objectiveId);
    case "item_owned": {
      const item = state.items[condition.itemId];
      const owned = Boolean(
        item &&
        (item.location.kind === "inventory" || item.location.kind === "equipped") &&
        item.location.ownerId === state.player.id
      );
      return owned === (condition.owned ?? true);
    }
  }
}
