import type { Decider } from "./decide.ts";
import { decideGmProposal } from "./gm-decider.ts";
import { decideItem, decideMovement } from "./table-deciders.ts";
import type { GmProposal, GmTableProposal } from "../types/gm-proposals.ts";
import type { ProposalEnvelope } from "../types/proposals.ts";
import type { ItemProposal, MovementProposal } from "../types/table-proposals.ts";

const itemKinds = new Set<ItemProposal["kind"]>([
  "create_item",
  "grant_item_reward",
  "pick_up_item",
  "drop_item",
  "equip_item",
  "consume_item",
]);

export const decideGmTableProposal: Decider<GmTableProposal, GmTableProposal> = (state, envelope, context) => {
  if (envelope.source.kind === "world_script") {
    return {
      accepted: false,
      rejection: {
        code: "permission_denied",
        safeMessage: "That world rule cannot directly operate the GM table.",
        diagnostic: "World scripts must use an explicitly authorized engine host operation.",
        retryable: false,
      },
      events: [],
      warnings: [],
    };
  }
  if (envelope.payload.kind === "move_player") {
    return decideMovement(state, envelope as ProposalEnvelope<MovementProposal>, context);
  }
  if (itemKinds.has(envelope.payload.kind as ItemProposal["kind"])) {
    return decideItem(state, envelope as ProposalEnvelope<ItemProposal>, context);
  }
  return decideGmProposal(state, envelope as ProposalEnvelope<GmProposal>, context);
};
