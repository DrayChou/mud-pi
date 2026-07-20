import type { ParsedCommand } from "../ai/interpreter.ts";
import { formatConflictWarning } from "../content/default-conflict-copy.ts";
import { buildDmPrompt } from "../ai/dm-prompt.ts";
import { parseDmResponse } from "../ai/dm-parser.ts";
import { executeCommand } from "../engine/commands.ts";
import { defaultConflictResolver, type ConflictResolver } from "../engine/conflict-script.ts";
import { deriveGameEvents, type GameEventContext } from "../engine/game-events.ts";
import { projectPublicEvents } from "../engine/public-events.ts";
import { executeNpcDecision } from "../engine/npc-intents.ts";
import { evaluateProgress } from "../engine/progress.ts";
import { isMigratedTableMutation, settleRuntimeMutation } from "../store/domain-settlement.ts";
import { settleGmBatch } from "../store/gm-protocol.ts";
import { nextLegacyProposalId } from "../store/legacy-settlement.ts";
import { appendTurn, saveState } from "../store/persist.ts";
import type { GameEvent } from "../types/events.ts";
import type { AnyMutation, EngineMutation } from "../types/mutations.ts";
import type { ProposalBatchEnvelope } from "../types/proposals.ts";
import type { GmTableProposal } from "../types/gm-proposals.ts";
import type { NpcDecision, NpcPublicAction } from "../types/npc.ts";
import type { CommittedWorldEvent } from "../types/world-events.ts";
import type { StoryOutcomeDef, WorldState } from "../types/world.ts";
import type { GameOutput, GameTurnResult } from "./game-output.ts";
import { buildMapSnapshot, type MapSnapshot } from "../engine/map.ts";

export interface RuntimeInterpreter {
  parse(input: string): Promise<ParsedCommand>;
}

export interface RuntimeDm {
  ask(prompt: string): Promise<string>;
}

export interface RuntimeNpcSessions {
  respondToPlayerSay(
    state: WorldState,
    message: string,
    target?: string
  ): Promise<NpcDecision[]>;
  respondToEvents?(
    state: WorldState,
    events: GameEvent[],
    maxWakeups?: number
  ): Promise<NpcDecision[]>;
}

export interface GameRuntimeOptions {
  state: WorldState;
  storyOutcomes: StoryOutcomeDef[];
  interpreter: RuntimeInterpreter;
  dm: RuntimeDm;
  npcSessions: RuntimeNpcSessions;
  dmModelLabel?: string;
  persist?: boolean;
  conflictResolver?: ConflictResolver;
}

/** Transport-agnostic orchestration for one loaded game save. */
export class GameRuntime {
  readonly state: WorldState;
  private readonly storyOutcomes: StoryOutcomeDef[];
  private readonly interpreter: RuntimeInterpreter;
  private readonly dm: RuntimeDm;
  private readonly npcSessions: RuntimeNpcSessions;
  private readonly dmModelLabel: string;
  private readonly persist: boolean;
  private readonly conflictResolver: ConflictResolver;

  constructor(options: GameRuntimeOptions) {
    this.state = options.state;
    this.storyOutcomes = options.storyOutcomes;
    this.interpreter = options.interpreter;
    this.dm = options.dm;
    this.npcSessions = options.npcSessions;
    this.dmModelLabel = options.dmModelLabel ?? "dm";
    this.persist = options.persist ?? true;
    this.conflictResolver = options.conflictResolver ?? defaultConflictResolver;
  }

  getSnapshot(): WorldState {
    return structuredClone(this.state);
  }

  getMapSnapshot(): MapSnapshot {
    return buildMapSnapshot(this.state);
  }

  async save(): Promise<void> {
    await saveState(this.state);
  }

  private settleLegacyMutations(
    mutations: AnyMutation[],
    correlationId: string,
    sourceId: string,
  ): { mutations: typeof mutations; committedEvents: CommittedWorldEvent[]; gameEvents: GameEvent[] } {
    const accepted: typeof mutations = [];
    const committedEvents: CommittedWorldEvent[] = [];
    const gameEvents: GameEvent[] = [];
    for (const mutation of mutations) {
      const before = structuredClone(this.state);
      const settlement = settleRuntimeMutation(this.state, mutation, {
        proposalId: nextLegacyProposalId(sourceId),
        correlationId,
        sourceId,
        sourceKind: this.state.npcs[sourceId] ? "npc" : undefined,
      }, this.storyOutcomes);
      if (!settlement.accepted) continue;
      accepted.push(mutation as never);
      committedEvents.push(...settlement.committedEvents);
      if (isMigratedTableMutation(mutation)) {
        gameEvents.push(...settlement.committedEvents.flatMap((event) =>
          projectPublicEvents(event, publicProjectionContext(this.state))
        ));
      } else {
        gameEvents.push(...deriveGameEvents(before, [mutation], this.state));
      }
    }
    return { mutations: accepted, committedEvents, gameEvents };
  }

  async processInput(input: string): Promise<GameTurnResult> {
    const parsed = await this.interpreter.parse(input);
    const correlationId = nextLegacyProposalId("turn");
    const result = executeCommand(this.state, parsed, this.conflictResolver);

    if (result.directReply !== undefined) {
      if (result.directReply === "__QUIT__") {
        if (this.persist) await this.save();
        return { outputs: [], quit: true, turnAdvanced: false };
      }
      return {
        outputs: [{ kind: "direct_reply", text: result.directReply }],
        quit: false,
        turnAdvanced: false,
      };
    }

    const stateBeforeTurn = structuredClone(this.state);
    const engineSettlement = this.settleLegacyMutations(result.mutations as EngineMutation[], correlationId, "player_engine");
    const engineMuts = engineSettlement.mutations as EngineMutation[];

    const initialSpeechTarget = resolveSpeechTarget(stateBeforeTurn, parsed, []);
    const engineEvents = withPlayerSpeech(
      stateBeforeTurn,
      engineSettlement.gameEvents,
      parsed.verb === "say"
        ? { playerSpeech: { message: parsed.args.message ?? input, targetId: initialSpeechTarget } }
        : undefined
    );
    // Settle deterministic player-driven objective progress before waking NPCs,
    // so an NPC can perceive a just-completed task and choose a world-valid reward.
    const proposedPlayerProgressMutations = evaluateProgress(this.state, engineEvents);
    const playerProgressSettlement = this.settleLegacyMutations(
      proposedPlayerProgressMutations,
      correlationId,
      "objective_engine",
    );
    const playerProgressMutations = playerProgressSettlement.mutations as EngineMutation[];
    const playerProgressEvents = playerProgressSettlement.gameEvents;
    const npcPerceptionEvents = [...engineEvents, ...playerProgressEvents];

    const sessionDecisions = result.combatContext
      ? []
      : this.npcSessions.respondToEvents
      ? await this.npcSessions.respondToEvents(this.state, npcPerceptionEvents, 2)
      : parsed.verb === "say"
        ? await this.npcSessions.respondToPlayerSay(
            this.state,
            parsed.args.message ?? input,
            parsed.args.target
          )
        : [];
    const npcDecisions = sessionDecisions;
    const npcActions: NpcPublicAction[] = [];
    const npcMutations: EngineMutation[] = [];
    const npcGameEvents: GameEvent[] = [];
    for (const decision of npcDecisions) {
      const npcResult = executeNpcDecision(this.state, decision);
      const npcSettlement = this.settleLegacyMutations(
        npcResult.mutations,
        correlationId,
        npcResult.action.npcId,
      );
      const allNpcMutationsAccepted = npcSettlement.mutations.length === npcResult.mutations.length;
      if (!allNpcMutationsAccepted || (
        npcResult.action.verb === "give_item" &&
        npcResult.action.succeeded &&
        (!npcResult.action.itemId || this.state.items[npcResult.action.itemId]?.grantedByEntityId !== npcResult.action.npcId)
      )) {
        npcActions.push({ ...npcResult.action, succeeded: false, reason: "动作在最终权威结算中被拒绝" });
      } else {
        npcMutations.push(...npcSettlement.mutations as EngineMutation[]);
        npcGameEvents.push(...npcSettlement.gameEvents);
        npcActions.push(npcResult.action);
      }
    }

    const speechTarget = resolveSpeechTarget(stateBeforeTurn, parsed, npcDecisions);
    const preDmBaseEvents = withPlayerSpeech(
      stateBeforeTurn,
      [...engineSettlement.gameEvents, ...playerProgressSettlement.gameEvents, ...npcGameEvents],
      parsed.verb === "say"
        ? { playerSpeech: { message: parsed.args.message ?? input, targetId: speechTarget } }
        : undefined
    );
    const proposedNpcProgressMutations = evaluateProgress(this.state, preDmBaseEvents);
    const npcProgressSettlement = this.settleLegacyMutations(
      proposedNpcProgressMutations,
      correlationId,
      "objective_engine",
    );
    const npcProgressMutations = npcProgressSettlement.mutations as EngineMutation[];
    const npcProgressEvents = npcProgressSettlement.gameEvents;
    const preDmEvents = [...preDmBaseEvents, ...npcProgressEvents];
    const preDmProgressMutations = [...playerProgressMutations, ...npcProgressMutations];

    const dmPrompt = buildDmPrompt(
      this.state,
      input,
      [...engineMuts, ...preDmProgressMutations],
      result.combatContext,
      npcActions,
      this.storyOutcomes,
      preDmEvents
    );
    const dmRaw = await this.dm.ask(dmPrompt);
    const dmResponse = parseDmResponse(
      dmRaw,
      this.state.schema,
      this.state.player.roomId,
      this.storyOutcomes,
      this.state.turn,
      this.state.player.id
    );

    const gmBatchEvents: GameEvent[] = [];
    if (dmResponse.gmOperations.length > 0) {
      const batch: ProposalBatchEnvelope<GmTableProposal> = {
        batchId: nextLegacyProposalId("dm-batch"),
        correlationId,
        source: { kind: "dm", id: "dm" },
        expectedRevision: this.state.revision,
        observedTurn: this.state.turn,
        proposals: dmResponse.gmOperations.map((payload) => ({ proposalId: nextLegacyProposalId("dm-operation"), payload })),
      };
      const batchSettlement = settleGmBatch(this.state, batch, this.storyOutcomes);
      for (const settlement of batchSettlement.settlements) {
        if (!settlement.accepted) continue;
        const context = publicProjectionContext(this.state);
        gmBatchEvents.push(...settlement.committedEvents.flatMap((event) => projectPublicEvents(event, context)));
      }
    }

    const outcomeMutations = dmResponse.mutations.filter(
      (mutation) => mutation.kind === "dm/outcome_reached"
    );
    const worldDmMutations = dmResponse.mutations.filter(
      (mutation) => mutation.kind !== "dm/outcome_reached"
    );
    const worldDmSettlement = this.settleLegacyMutations(
      worldDmMutations,
      correlationId,
      "dm",
    );
    const settledWorldDmMutations = worldDmSettlement.mutations as typeof worldDmMutations;

    const postDmEngineMuts: EngineMutation[] = [];
    const postDmEngineGameEvents: GameEvent[] = [];
    if (parsed.verb === "get" && !engineMuts.some((mutation) => mutation.kind === "engine/item_picked_up")) {
      const retry = executeCommand(this.state, parsed, this.conflictResolver);
      if (retry.directReply === undefined) {
        const retrySettlement = this.settleLegacyMutations(
          retry.mutations,
          correlationId,
          "player_engine_retry",
        );
        postDmEngineMuts.push(...retrySettlement.mutations as EngineMutation[]);
        postDmEngineGameEvents.push(...retrySettlement.gameEvents);
      }
    }

    const postDmEvents = [...gmBatchEvents, ...worldDmSettlement.gameEvents, ...postDmEngineGameEvents];
    const proposedPostDmProgressMutations = evaluateProgress(this.state, postDmEvents);
    const postDmProgressSettlement = this.settleLegacyMutations(
      proposedPostDmProgressMutations,
      correlationId,
      "objective_engine",
    );
    const postDmProgressMutations = postDmProgressSettlement.mutations as EngineMutation[];
    const settledOutcomeMutations = this.settleLegacyMutations(
      outcomeMutations,
      correlationId,
      "dm",
    ).mutations as typeof outcomeMutations;

    const gameEvents = [...preDmEvents, ...postDmEvents];
    const progressMutations = [...preDmProgressMutations, ...postDmProgressMutations];
    this.settleLegacyMutations([{ kind: "engine/turn_advanced" }], correlationId, "turn_engine");

    if (this.persist) {
      await saveState(this.state);
      await appendTurn(this.state.worldId, {
        turn: this.state.turn,
        ts: Date.now(),
        playerInput: input,
        parsed: {
          verb: parsed.verb,
          args: parsed.args,
          confidence: parsed.confidence,
        },
        engineMutations: [...engineMuts, ...postDmEngineMuts, ...progressMutations],
        dmMutations: [...settledWorldDmMutations, ...settledOutcomeMutations],
        gameEvents,
        npcActions,
        narration: dmResponse.narration,
        dmModel: this.dmModelLabel,
      });
    }

    const outputs: GameOutput[] = [];
    if (result.combatContext?.risk === "likely_failure") {
      outputs.push({
        kind: "combat_warning",
        risk: "likely_failure",
        text: formatConflictWarning(this.state.conflictRules, "likely_failure", result.combatContext),
      });
    } else if (result.combatContext?.risk === "dangerous") {
      outputs.push({
        kind: "combat_warning",
        risk: "dangerous",
        text: formatConflictWarning(this.state.conflictRules, "dangerous", result.combatContext),
      });
    }
    if (result.combatContext) outputs.push({ kind: "combat_result", result: result.combatContext });
    outputs.push({ kind: "narration", text: dmResponse.narration });
    for (const mutation of progressMutations) {
      if (mutation.kind !== "engine/objective_completed") continue;
      const objective = this.state.objectives[mutation.objectiveId];
      if (objective) {
        outputs.push({
          kind: "objective_completed",
          objectiveId: objective.id,
          title: objective.title,
        });
      }
    }
    if (!stateBeforeTurn.outcome && this.state.outcome) {
      outputs.push({ kind: "story_outcome", outcome: structuredClone(this.state.outcome) });
    }
    if (engineMuts.some((mutation) => mutation.kind === "engine/player_moved")) {
      outputs.push({ kind: "room_changed", roomId: this.state.player.roomId });
    }

    return { outputs, quit: false, turnAdvanced: true };
  }
}

function publicProjectionContext(state: WorldState) {
  return {
    playerId: state.player.id,
    playerRoomId: state.player.roomId,
    entityRoomIds: Object.fromEntries([
      [state.player.id, state.player.roomId],
      ...Object.values(state.npcs).map((npc) => [npc.id, npc.roomId] as const),
    ]),
    criticalNpcs: Object.fromEntries(
      Object.values(state.npcs)
        .filter((npc) => npc.storyRole?.importance === "critical")
        .map((npc) => [npc.id, {
          deathPolicy: npc.storyRole?.deathPolicy,
          notes: npc.storyRole?.notes,
        }] as const),
    ),
  };
}

function withPlayerSpeech(
  before: WorldState,
  settledEvents: GameEvent[],
  context: GameEventContext = {},
): GameEvent[] {
  return [...deriveGameEvents(before, [], before, context), ...settledEvents];
}

function resolveSpeechTarget(
  stateBeforeTurn: WorldState,
  parsed: ParsedCommand,
  npcDecisions: NpcDecision[]
): string | undefined {
  if (parsed.verb !== "say") return undefined;
  if (!parsed.args.target) return npcDecisions[0]?.npcId;
  return Object.values(stateBeforeTurn.npcs).find(
    (npc) =>
      npc.roomId === stateBeforeTurn.player.roomId &&
      (npc.id.includes(parsed.args.target!) || npc.name.includes(parsed.args.target!))
  )?.id;
}
