import type { ParsedCommand } from "../ai/interpreter.ts";
import { formatConflictWarning } from "../content/default-conflict-copy.ts";
import { buildDmPrompt } from "../ai/dm-prompt.ts";
import { parseDmResponse } from "../ai/dm-parser.ts";
import { executeCommand } from "../engine/commands.ts";
import { defaultConflictResolver, type ConflictResolver } from "../engine/conflict-script.ts";
import { deriveGameEvents } from "../engine/game-events.ts";
import { executeNpcDecision } from "../engine/npc-intents.ts";
import { evaluateProgress } from "../engine/progress.ts";
import { applyMutation, applyMutations } from "../store/apply.ts";
import { appendTurn, saveState } from "../store/persist.ts";
import type { GameEvent } from "../types/events.ts";
import type { EngineMutation } from "../types/mutations.ts";
import type { NpcDecision, NpcPublicAction } from "../types/npc.ts";
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

  async processInput(input: string): Promise<GameTurnResult> {
    const parsed = await this.interpreter.parse(input);
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
    const engineMuts = result.mutations as EngineMutation[];
    applyMutations(this.state, engineMuts);

    const initialSpeechTarget = resolveSpeechTarget(stateBeforeTurn, parsed, []);
    const engineEvents = deriveGameEvents(
      stateBeforeTurn,
      engineMuts,
      this.state,
      parsed.verb === "say"
        ? { playerSpeech: { message: parsed.args.message ?? input, targetId: initialSpeechTarget } }
        : undefined
    );
    const sessionDecisions = result.combatContext
      ? []
      : this.npcSessions.respondToEvents
      ? await this.npcSessions.respondToEvents(this.state, engineEvents, 2)
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
    for (const decision of npcDecisions) {
      const npcResult = executeNpcDecision(this.state, decision);
      applyMutations(this.state, npcResult.mutations);
      npcMutations.push(...npcResult.mutations);
      npcActions.push(npcResult.action);
    }

    const speechTarget = resolveSpeechTarget(stateBeforeTurn, parsed, npcDecisions);
    const preDmEvents = deriveGameEvents(
      stateBeforeTurn,
      [...engineMuts, ...npcMutations],
      this.state,
      parsed.verb === "say"
        ? { playerSpeech: { message: parsed.args.message ?? input, targetId: speechTarget } }
        : undefined
    );
    const preDmProgressMutations = evaluateProgress(this.state, preDmEvents);
    applyMutations(this.state, preDmProgressMutations);

    const stateBeforeDm = structuredClone(this.state);
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

    const outcomeMutations = dmResponse.mutations.filter(
      (mutation) => mutation.kind === "dm/outcome_reached"
    );
    const worldDmMutations = dmResponse.mutations.filter(
      (mutation) => mutation.kind !== "dm/outcome_reached"
    );
    applyMutations(this.state, worldDmMutations);

    const postDmEngineMuts: EngineMutation[] = [];
    if (parsed.verb === "get" && !engineMuts.some((mutation) => mutation.kind === "engine/item_picked_up")) {
      const retry = executeCommand(this.state, parsed, this.conflictResolver);
      if (retry.directReply === undefined) {
        postDmEngineMuts.push(...retry.mutations);
        applyMutations(this.state, retry.mutations);
      }
    }

    const postDmEvents = deriveGameEvents(
      stateBeforeDm,
      [...worldDmMutations, ...postDmEngineMuts],
      this.state
    );
    const postDmProgressMutations = evaluateProgress(this.state, postDmEvents);
    applyMutations(this.state, postDmProgressMutations);
    applyMutations(this.state, outcomeMutations);

    const gameEvents = [...preDmEvents, ...postDmEvents];
    const progressMutations = [...preDmProgressMutations, ...postDmProgressMutations];
    applyMutation(this.state, { kind: "engine/turn_advanced" });

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
        dmMutations: dmResponse.mutations,
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
