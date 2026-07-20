import type { Decision, ProposalEnvelope } from "../types/proposals.ts";
import type { StoryOutcomeDef, WorldState } from "../types/world.ts";

export interface ConflictResolver {
  readonly id?: string;
}

export interface DecisionContext {
  storyOutcomes: readonly StoryOutcomeDef[];
  conflictResolver?: ConflictResolver;
}

export type Decider<TProposal, TResult = unknown> = (
  state: Readonly<WorldState>,
  proposal: ProposalEnvelope<TProposal>,
  context: Readonly<DecisionContext>,
) => Decision<TResult>;
