import type { AnyMutation } from "./mutations.ts";
import type { ItemDef } from "./world.ts";

export type ItemRewardGrantRequest = Extract<
  AnyMutation,
  { kind: "engine/item_reward_granted" | "dm/item_reward_granted" }
>;

export type MovementProposal = {
  kind: "move_player";
  toRoomId: string;
};

export type ItemProposal =
  | { kind: "create_item"; item: ItemDef }
  | { kind: "grant_item_reward"; request: ItemRewardGrantRequest }
  | { kind: "pick_up_item"; itemId: string }
  | { kind: "drop_item"; itemId: string; roomId: string }
  | { kind: "equip_item"; itemId: string; slot: string }
  | { kind: "consume_item"; itemId: string };
