import { simulateCombat } from "../../src/engine/combat.ts";
import { defaultConflictResolver, type ConflictResolver } from "../../src/engine/conflict-script.ts";

export const conflictResolver: ConflictResolver = {
  id: "station-dream-conflict",
  version: 1,
  resolve(context) {
    if (context.rules.mode !== "auto_combat") throw new Error("station-dream expects auto combat rules");
    return simulateCombat(
      context.schema,
      context.actor,
      context.target,
      context.rules,
      context.seed
    );
  },
  useItem: defaultConflictResolver.useItem,
};
