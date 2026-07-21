import type { ParsedCommand } from "../ai/interpreter.ts";
import { formatConflictWarning } from "../content/default-conflict-copy.ts";
import { buildDmPrompt } from "../ai/dm-prompt.ts";
import {
  buildNarrationCorrectionPrompt,
  fallbackNarration,
  narrationNeedsCorrection,
  parseNarrationCorrection,
  type NarrationSettlementIssue,
} from "../ai/dm-correction.ts";
import { parseDmResponse } from "../ai/dm-parser.ts";
import { executeCommand } from "../engine/commands.ts";
import { actionIntentFromParsed, completionCommandForIntent, resolveActionIntent } from "../engine/action-intent.ts";
import { defaultConflictResolver, type ConflictResolver } from "../engine/conflict-script.ts";
import { deriveGameEvents, type GameEventContext } from "../engine/game-events.ts";
import { projectPublicEvents } from "../engine/public-events.ts";
import { executeNpcDecision } from "../engine/npc-intents.ts";
import { evaluateProgress } from "../engine/progress.ts";
import { isMigratedTableMutation, settleRuntimeMutation } from "../store/domain-settlement.ts";
import { settleGmOperation } from "../store/gm-protocol.ts";
import { nextLegacyProposalId } from "../store/legacy-settlement.ts";
import { appendTurn, saveState } from "../store/persist.ts";
import { completeOutbox, drainPersistenceOutbox, enqueueOutbox, pendingOutbox } from "../store/outbox.ts";
import { clearStagedJournalOutbox, stageJournalOutbox } from "../store/journal.ts";
import type { GameEvent } from "../types/events.ts";
import type { AnyMutation, DmMutation, EngineMutation } from "../types/mutations.ts";
import { normalizeTableOperations } from "../engine/table-operations.ts";
import { validateNarrativeClaims } from "../engine/narrative-claims.ts";
import type { NpcDecision, NpcPublicAction } from "../types/npc.ts";
import type { CommittedWorldEvent } from "../types/world-events.ts";
import type { StoryOutcomeDef, WorldState } from "../types/world.ts";
import type { GameOutput, GameTurnResult } from "./game-output.ts";
import {
  appendErrorLog,
  appendOperationLog,
  runWithDiagnosticContext,
  serializeError,
  type RuntimeChannel,
} from "../diagnostics/logger.ts";
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
  channel?: RuntimeChannel;
  diagnostics?: boolean;
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
  private readonly channel: RuntimeChannel;
  private readonly diagnostics: boolean;

  constructor(options: GameRuntimeOptions) {
    this.state = options.state;
    this.storyOutcomes = options.storyOutcomes;
    this.interpreter = options.interpreter;
    this.dm = options.dm;
    this.npcSessions = options.npcSessions;
    this.dmModelLabel = options.dmModelLabel ?? "dm";
    this.persist = options.persist ?? true;
    this.conflictResolver = options.conflictResolver ?? defaultConflictResolver;
    this.channel = options.channel ?? "system";
    this.diagnostics = options.diagnostics ?? this.persist;
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
  ): { mutations: typeof mutations; committedEvents: CommittedWorldEvent[]; gameEvents: GameEvent[]; narrationIssues: NarrationSettlementIssue[] } {
    const accepted: typeof mutations = [];
    const committedEvents: CommittedWorldEvent[] = [];
    const gameEvents: GameEvent[] = [];
    const narrationIssues: NarrationSettlementIssue[] = [];
    for (const mutation of mutations) {
      const before = structuredClone(this.state);
      const settlement = settleRuntimeMutation(this.state, mutation, {
        proposalId: nextLegacyProposalId(sourceId),
        correlationId,
        sourceId,
        sourceKind: this.state.npcs[sourceId] ? "npc" : undefined,
      }, this.storyOutcomes);
      appendOperationLog(this.state.worldId, {
        kind: "settlement",
        domain: "legacy_runtime",
        proposalId: settlement.proposal.proposalId,
        sourceId,
        mutationKind: mutation.kind,
        accepted: settlement.accepted,
        rejection: settlement.accepted ? undefined : settlement.rejection,
        warningCodes: settlement.accepted ? settlement.warnings.map((warning) => warning.code) : [],
        eventKinds: settlement.accepted ? settlement.committedEvents.map(({ event }) => event.kind) : [],
        revisionBefore: before.revision,
        revisionAfter: this.state.revision,
      });
      if (!settlement.accepted) {
        narrationIssues.push({ proposalId: settlement.proposal.proposalId, kind: "rejection", rejection: settlement.rejection });
        continue;
      }
      accepted.push(mutation as never);
      committedEvents.push(...settlement.committedEvents);
      for (const warning of settlement.warnings) {
        narrationIssues.push({ proposalId: settlement.proposal.proposalId, kind: "warning", warning });
      }
      if (isMigratedTableMutation(mutation)) {
        gameEvents.push(...settlement.committedEvents.flatMap((event) =>
          projectPublicEvents(event, publicProjectionContext(this.state))
        ));
      } else {
        gameEvents.push(...deriveGameEvents(before, [mutation], this.state));
      }
    }
    return { mutations: accepted, committedEvents, gameEvents, narrationIssues };
  }

  private async respondToEventsDurably(
    events: GameEvent[],
    maxWakeups: number,
    correlationId: string,
    phase: "pre_dm" | "post_dm" | "recovery",
  ): Promise<{ decisions: NpcDecision[]; effectId?: string }> {
    if (!this.npcSessions.respondToEvents) return { decisions: [] };
    const effectId = this.persist
      ? enqueueOutbox(this.state.worldId, {
          kind: "npc_perception",
          worldId: this.state.worldId,
          events,
          maxWakeups,
          correlationId,
          phase,
        })
      : undefined;
    const decisions = await this.npcSessions.respondToEvents(this.state, events, maxWakeups);
    return { decisions, effectId };
  }

  private async recoverNpcPerceptions(): Promise<void> {
    if (!this.persist || !this.npcSessions.respondToEvents) return;
    const pending = await pendingOutbox(this.state.worldId);
    for (const record of pending) {
      if (record.effect.kind !== "npc_perception") continue;
      const decisions = await this.npcSessions.respondToEvents(
        this.state,
        record.effect.events,
        record.effect.maxWakeups,
      );
      for (const decision of decisions) {
        const npcResult = executeNpcDecision(this.state, decision);
        this.settleLegacyMutations(npcResult.mutations, record.effect.correlationId, npcResult.action.npcId);
      }
      completeOutbox(this.state.worldId, record.effectId);
    }
  }

  async processOpening(): Promise<GameTurnResult> {
    return await this.runLoggedOperation("opening", "开始游戏，玩家刚刚进入世界", async () => {
      await this.recoverNpcPerceptions();
      const parsed = {
        verb: "look",
        args: {},
        confidence: 1,
        raw: "开始游戏，玩家刚刚进入世界",
      };
      appendOperationLog(this.state.worldId, { kind: "input_parsed", parsed });
      return await this.processParsedInput(parsed.raw, parsed);
    });
  }

  async processInput(input: string): Promise<GameTurnResult> {
    return await this.runLoggedOperation("player_input", input, async () => {
      await this.recoverNpcPerceptions();
      const parsed = await this.interpreter.parse(input);
      appendOperationLog(this.state.worldId, { kind: "input_parsed", parsed });
      return await this.processParsedInput(input, parsed);
    });
  }

  private async runLoggedOperation(
    operation: "opening" | "player_input",
    input: string,
    execute: () => Promise<GameTurnResult>,
  ): Promise<GameTurnResult> {
    if (!this.diagnostics) return await execute();
    const requestId = crypto.randomUUID();
    const turnBefore = this.state.turn;
    const revisionBefore = this.state.revision;
    const startedAt = performance.now();
    return await runWithDiagnosticContext({
      worldId: this.state.worldId,
      requestId,
      channel: this.channel,
      turn: turnBefore,
      revision: revisionBefore,
    }, async () => {
      appendOperationLog(this.state.worldId, {
        kind: "runtime_operation_started",
        operation,
        input,
        turnBefore,
        revisionBefore,
      });
      try {
        const result = await execute();
        appendOperationLog(this.state.worldId, {
          kind: "runtime_operation_completed",
          operation,
          input,
          quit: result.quit,
          turnAdvanced: result.turnAdvanced,
          outputKinds: result.outputs.map((output) => output.kind),
          outputs: result.outputs,
          turnBefore,
          turnAfter: this.state.turn,
          revisionBefore,
          revisionAfter: this.state.revision,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return result;
      } catch (error) {
        const diagnosticError = serializeError(error);
        appendOperationLog(this.state.worldId, {
          kind: "runtime_operation_failed",
          operation,
          input,
          turnBefore,
          turnAfter: this.state.turn,
          revisionBefore,
          revisionAfter: this.state.revision,
          durationMs: Math.round(performance.now() - startedAt),
          error: diagnosticError,
        });
        appendErrorLog(this.state.worldId, { kind: "runtime_error", operation, error: diagnosticError });
        throw error;
      }
    });
  }

  private async processParsedInput(input: string, parsed: ParsedCommand): Promise<GameTurnResult> {
    const correlationId = nextLegacyProposalId("turn");
    const resolvedIntent = resolveActionIntent(this.state, actionIntentFromParsed(parsed));
    const shouldExecuteBeforeDm = !resolvedIntent.requiresSemanticAdjudication
      || this.state.player.lifecycle !== "active"
      || Boolean(this.state.outcome?.terminal);
    let result = shouldExecuteBeforeDm
      ? executeCommand(this.state, parsed, this.conflictResolver)
      : { mutations: [] as EngineMutation[] };
    const semanticDirectReply = result.directReply !== undefined
      && resolvedIntent.requiresSemanticAdjudication
      && this.state.player.lifecycle === "active"
      && !this.state.outcome?.terminal;
    if (semanticDirectReply) {
      appendOperationLog(this.state.worldId, {
        kind: "semantic_direct_reply_deferred",
        verb: parsed.verb,
        directReply: result.directReply,
        unresolvedReferences: [
          ...resolvedIntent.resolvedTargets,
          ...resolvedIntent.resolvedTools,
          ...(resolvedIntent.resolvedDestination ? [resolvedIntent.resolvedDestination] : []),
        ].filter((reference) => reference.resolution === "missing" || reference.resolution === "ambiguous"),
      });
      result = { mutations: [], combatContext: result.combatContext };
    }

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

    const durableNpcResponse = !result.combatContext && this.npcSessions.respondToEvents
      ? await this.respondToEventsDurably(npcPerceptionEvents, 2, correlationId, "pre_dm")
      : undefined;
    const sessionDecisions = durableNpcResponse?.decisions ?? (
      !result.combatContext && parsed.verb === "say"
        ? await this.npcSessions.respondToPlayerSay(
            this.state,
            parsed.args.message ?? input,
            parsed.args.target
          )
        : []
    );
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
    if (durableNpcResponse?.effectId) completeOutbox(this.state.worldId, durableNpcResponse.effectId);

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
      preDmEvents,
      resolvedIntent,
    );
    let dmRaw: string;
    try {
      dmRaw = await this.dm.ask(dmPrompt);
    } catch (error) {
      appendOperationLog(this.state.worldId, {
        kind: "ai_fallback",
        phase: "dm_turn",
        reason: serializeError(error),
      });
      dmRaw = `<NARRATION>${dmUnavailableNarration(this.state, parsed, engineMuts)}</NARRATION><WORLD_UPDATE>{"gmOperations":[],"worldFacts":[],"factsRemoved":[],"plotThreads":[],"roomsAdded":[],"exitsAdded":[],"roomDescUpdates":[],"itemsAdded":[],"npcsAdded":[],"npcsMoved":[],"npcsKilled":[],"outcomeReached":null}</WORLD_UPDATE>`;
    }
    const dmResponse = parseDmResponse(
      dmRaw,
      this.state.schema,
      this.state.player.roomId,
      this.storyOutcomes,
      this.state.turn,
      this.state.player.id
    );

    const dmPlanEvents: GameEvent[] = [];
    const settledWorldDmMutations: DmMutation[] = [];
    const settledOutcomeMutations: DmMutation[] = [];
    const narrationIssues: NarrationSettlementIssue[] = dmResponse.parseIssues.map((issue, index) => ({
      proposalId: `dm-parse-${index}`,
      kind: "rejection",
      rejection: {
        code: issue.code,
        safeMessage: "That proposed world change could not be understood safely.",
        diagnostic: issue.message,
        details: issue.details,
        retryable: false,
      },
    }));
    const normalizedDmPlan = normalizeTableOperations(dmResponse.mutations, dmResponse.gmOperations);
    const deferredOutcomeOperations = normalizedDmPlan.filter((entry) => entry.phase === "outcome");
    appendOperationLog(this.state.worldId, {
      kind: "dm_table_plan",
      operationCount: normalizedDmPlan.length,
      operations: normalizedDmPlan.map((entry) => ({
        source: entry.source,
        phase: entry.phase,
        kind: entry.operation.kind,
      })),
    });
    for (const entry of normalizedDmPlan) {
      if (entry.phase === "outcome") continue;
      if (entry.source === "legacy_world_update") {
        const settlement = this.settleLegacyMutations([entry.operation], correlationId, "dm");
        settledWorldDmMutations.push(...settlement.mutations as DmMutation[]);
        dmPlanEvents.push(...settlement.gameEvents);
        narrationIssues.push(...settlement.narrationIssues);
        continue;
      }
      const settlement = settleGmOperation(this.state, {
        proposalId: nextLegacyProposalId("dm-operation"),
        correlationId,
        source: { kind: "dm", id: "dm" },
        expectedRevision: this.state.revision,
        observedTurn: this.state.turn,
        payload: entry.operation,
      }, this.storyOutcomes);
      if (!settlement.accepted) {
        narrationIssues.push({ proposalId: settlement.proposal.proposalId, kind: "rejection", rejection: settlement.rejection });
        continue;
      }
      for (const warning of settlement.warnings) {
        narrationIssues.push({ proposalId: settlement.proposal.proposalId, kind: "warning", warning });
      }
      dmPlanEvents.push(...settlement.committedEvents.flatMap((event) =>
        projectPublicEvents(event, publicProjectionContext(this.state))
      ));
    }

    const postDmEngineMuts: EngineMutation[] = [];
    const postDmEngineGameEvents: GameEvent[] = [];
    if (engineMuts.length === 0) {
      const refreshedIntent = resolveActionIntent(this.state, actionIntentFromParsed(parsed));
      const completionCommand = completionCommandForIntent(refreshedIntent, parsed);
      if (completionCommand) {
        const completion = executeCommand(this.state, completionCommand, this.conflictResolver);
        if (completion.directReply === undefined) {
          const completionSettlement = this.settleLegacyMutations(
            completion.mutations,
            correlationId,
            "player_intent_completion",
          );
          postDmEngineMuts.push(...completionSettlement.mutations as EngineMutation[]);
          postDmEngineGameEvents.push(...completionSettlement.gameEvents);
        }
      }
    }

    const postDmEvents = [...dmPlanEvents, ...postDmEngineGameEvents];
    const remainingNpcWakeups = Math.max(0, 2 - sessionDecisions.length);
    if (!result.combatContext && remainingNpcWakeups > 0 && postDmEvents.length > 0 && this.npcSessions.respondToEvents) {
      const postDmNpcResponse = await this.respondToEventsDurably(postDmEvents, remainingNpcWakeups, correlationId, "post_dm");
      for (const decision of postDmNpcResponse.decisions) {
        const npcResult = executeNpcDecision(this.state, decision);
        const npcSettlement = this.settleLegacyMutations(npcResult.mutations, correlationId, npcResult.action.npcId);
        const accepted = npcSettlement.mutations.length === npcResult.mutations.length;
        if (accepted) {
          npcMutations.push(...npcSettlement.mutations as EngineMutation[]);
          npcGameEvents.push(...npcSettlement.gameEvents);
          postDmEvents.push(...npcSettlement.gameEvents);
          npcActions.push(npcResult.action);
        } else {
          npcActions.push({ ...npcResult.action, succeeded: false, reason: "动作在最终权威结算中被拒绝" });
        }
      }
      if (postDmNpcResponse.effectId) completeOutbox(this.state.worldId, postDmNpcResponse.effectId);
    }
    const proposedPostDmProgressMutations = evaluateProgress(this.state, postDmEvents);
    const postDmProgressSettlement = this.settleLegacyMutations(
      proposedPostDmProgressMutations,
      correlationId,
      "objective_engine",
    );
    const postDmProgressMutations = postDmProgressSettlement.mutations as EngineMutation[];
    for (const entry of deferredOutcomeOperations) {
      if (entry.source === "legacy_world_update") {
        const settlement = this.settleLegacyMutations([entry.operation], correlationId, "dm");
        settledOutcomeMutations.push(...settlement.mutations as DmMutation[]);
        postDmEvents.push(...settlement.gameEvents);
        narrationIssues.push(...settlement.narrationIssues);
        continue;
      }
      const settlement = settleGmOperation(this.state, {
        proposalId: nextLegacyProposalId("dm-outcome"),
        correlationId,
        source: { kind: "dm", id: "dm" },
        expectedRevision: this.state.revision,
        observedTurn: this.state.turn,
        payload: entry.operation,
      }, this.storyOutcomes);
      if (!settlement.accepted) {
        narrationIssues.push({ proposalId: settlement.proposal.proposalId, kind: "rejection", rejection: settlement.rejection });
      } else {
        postDmEvents.push(...settlement.committedEvents.flatMap((event) =>
          projectPublicEvents(event, publicProjectionContext(this.state))
        ));
      }
    }

    for (const [index, issue] of validateNarrativeClaims(this.state, dmResponse.narrativeClaims).entries()) {
      narrationIssues.push({
        proposalId: `narrative-claim-${index}`,
        kind: "rejection",
        rejection: {
          code: "event_invariant_failed",
          safeMessage: "The candidate narration claimed a state change that was not committed.",
          diagnostic: issue.message,
          details: { claim: issue.claim },
          retryable: false,
        },
      });
    }

    const expirySettlement = settleGmOperation(this.state, {
      proposalId: nextLegacyProposalId("condition-expiry"),
      correlationId,
      source: { kind: "engine", id: "condition_engine" },
      expectedRevision: this.state.revision,
      observedTurn: this.state.turn,
      payload: { kind: "expire_conditions", throughTurn: this.state.turn + 1 },
    }, this.storyOutcomes);
    if (expirySettlement.accepted) {
      postDmEvents.push(...expirySettlement.committedEvents.flatMap((event) =>
        projectPublicEvents(event, publicProjectionContext(this.state))
      ));
    }

    const gameEvents = [...preDmEvents, ...postDmEvents];
    const progressMutations = [...preDmProgressMutations, ...postDmProgressMutations];
    let narration = dmResponse.narration;
    if (narrationNeedsCorrection(narrationIssues)) {
      try {
        const correctionRaw = await this.dm.ask(buildNarrationCorrectionPrompt(
          this.state,
          narration,
          narrationIssues,
          gameEvents,
        ));
        narration = parseNarrationCorrection(correctionRaw) ?? fallbackNarration(this.state, narrationIssues);
      } catch (error) {
        appendOperationLog(this.state.worldId, {
          kind: "ai_fallback",
          phase: "dm_narration_correction",
          reason: serializeError(error),
        });
        narration = fallbackNarration(this.state, narrationIssues);
      }
    }
    const turnRecord = this.persist ? {
        turn: this.state.turn + 1,
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
        narration,
        dmModel: this.dmModelLabel,
      } : undefined;
    if (turnRecord) {
      stageJournalOutbox(this.state, [
        { kind: "snapshot", worldId: this.state.worldId, revision: this.state.revision + 1 },
        { kind: "turn_record", worldId: this.state.worldId, record: turnRecord },
      ]);
    }
    const turnSettlement = this.settleLegacyMutations([{ kind: "engine/turn_advanced" }], correlationId, "turn_engine");
    if (turnRecord && turnSettlement.mutations.length === 0) clearStagedJournalOutbox(this.state);

    if (this.persist) {
      await drainPersistenceOutbox(this.state.worldId, this.state, {
        saveSnapshot: saveState,
        appendTurn: (record) => appendTurn(this.state.worldId, record),
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
    outputs.push({ kind: "narration", text: narration });
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

function dmUnavailableNarration(
  state: WorldState,
  parsed: ParsedCommand,
  engineMutations: EngineMutation[],
): string {
  const room = state.rooms[state.player.roomId];
  if (engineMutations.some((mutation) => mutation.kind === "engine/item_picked_up")) {
    return "你完成了拾取，物品已经进入背包。四周暂时没有新的回应。";
  }
  if (engineMutations.some((mutation) => mutation.kind === "engine/player_moved")) {
    return `你来到${room?.title ?? "新的地点"}。周围暂时只有既有景象，没有新的声音回应。`;
  }
  if (parsed.verb === "look") {
    return `${room?.desc ?? "你重新观察四周。"} 暂时没有发现超出眼前权威状态的新变化。`;
  }
  return "你的行动已经被记录；Pi DM 暂时没有补充新的叙述。";
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
