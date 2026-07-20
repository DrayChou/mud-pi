# Authoritative Settlement Contract

> Status: **Draft for human approval**  
> Scope: Contract freeze for tasks #41–#44. This document defines interfaces and invariants; it does not yet authorize production migration.

## 1. Purpose

`mud-pi` uses a tabletop model:

- Pi is the persistent GM;
- world packs are rulebooks, adventure modules and card catalogs;
- Engine is the authoritative digital table, character sheet, card manager, dice tower and campaign ledger.

The Settlement Kernel exists so every GM/table operation follows:

```text
untrusted Proposal
  → pure Decision
  → prepared committed facts
  → atomic Commit
  → State evolution
  → public projection and post-commit effects
```

It does **not** decide whether a lie is persuasive, whether a trap should trigger, or what makes an interesting story. Pi decides meaning; the Engine decides whether the resulting table operations can safely become facts.

---

## 2. Contract decisions

The following choices are frozen by this draft.

### 2.1 One ProposalEnvelope is one atomic domain operation

Examples:

- move the player to one room;
- pick up one item;
- equip one item, including returning the replaced item to inventory;
- resolve one conflict, including all parameter and lifecycle changes;
- grant one reward card;
- mark one objective complete.

All WorldEvents produced by one proposal commit together or not at all.

### 2.2 One Pi response is a ProposalBatch, not one giant transaction

A DM response may propose several independent operations. A bad optional item must not roll back an otherwise valid room description or story outcome.

The batch is checked against one observed revision, locked against interleaving, then its proposals are settled in declared order. Each accepted proposal is its own transaction and increments revision once. A rejected sibling does not roll back earlier accepted siblings.

Operations that must be all-or-nothing belong in **one** proposal and produce multiple events.

### 2.3 Revision and turn are different

- `turn` is narrative/player-turn time;
- `revision` is the version of authoritative table state;
- every committed transaction increments revision by exactly one;
- a rejected proposal does not change revision;
- an informational read does not change revision;
- a committed fact with no persistent field change, such as player speech, still increments revision because it enters the authoritative event history.

### 2.4 Decisions produce exact facts

Proposals may contain intent such as `delta: -3`. WorldEvents contain exact replay values such as `before: 8, after: 5`.

Threshold interpretation, clamping, permissions and stale checks belong in `decide()`, never in `evolve()`.

### 2.5 Candidate narration is not public before settlement

Pi narration is buffered until its table-operation batch has settled. If an operation is rejected or adjusted in a way that contradicts narration, Runtime must withhold the candidate narration and request at most one bounded correction from the same persistent DM Session.

### 2.6 Rejected proposals are audit data, not world facts

They must not reach:

- WorldEvent Journal;
- public GameEvent;
- Objective evaluation;
- NPC perception;
- UI/GMCP;
- TurnRecord as an executed action.

They may be retained in a separate bounded audit/feedback record.

---

## 3. Core types

The implementation may split these declarations across files, but must preserve their semantics.

```ts
export type ProposalSourceKind =
  | "player"
  | "dm"
  | "npc"
  | "engine"
  | "world_script";

export interface ProposalSource {
  kind: ProposalSourceKind;
  /** Player/NPC/world-script id, or a stable role id such as "dm"/"objective_engine". */
  id: string;
  /** Optional Pi Session id for private feedback and audit; never exposed publicly. */
  sessionId?: string;
}

export interface ProposalEnvelope<TProposal> {
  proposalId: string;
  correlationId: string;
  causationId?: string;
  source: ProposalSource;
  expectedRevision: number;
  observedTurn: number;
  payload: TProposal;
}
```

IDs are opaque stable strings. The first implementation may generate them from a process-local monotonic/crypto-safe helper; domain code must not parse meaning from IDs.

### 3.1 Proposal batches

```ts
export interface ProposalBatchEnvelope<TProposal> {
  batchId: string;
  correlationId: string;
  source: ProposalSource;
  expectedRevision: number;
  observedTurn: number;
  proposals: Array<{
    proposalId: string;
    causationId?: string;
    payload: TProposal;
  }>;
}
```

Batch rules:

1. Compare `expectedRevision` with current State once before the first proposal.
2. If stale, reject the entire batch without deciding children.
3. Prevent external interleaving while processing the batch.
4. Materialize each child as a `ProposalEnvelope` using the current sibling revision.
5. Settle children in array order.
6. Continue after a child rejection unless the batch policy explicitly says `stop_on_rejection` in a future extension.
7. Preserve one `correlationId` across every child transaction and correction request.

This sibling-revision rule is only available inside one locked batch. Unrelated stale proposals never receive automatic rebasing.

### 3.2 Rejections and warnings

```ts
export type SettlementRejectionCode =
  | "stale_revision"
  | "invalid_proposal"
  | "entity_not_found"
  | "duplicate_entity"
  | "invalid_location"
  | "invalid_parameter"
  | "invalid_value"
  | "permission_denied"
  | "precondition_failed"
  | "already_applied"
  | "unsupported_operation"
  | "event_invariant_failed"
  | "commit_failed";

export interface SettlementRejection {
  code: SettlementRejectionCode;
  /** Immersive/safe text suitable for a player-facing fallback when needed. */
  safeMessage: string;
  /** Developer/GM diagnostic. Must not contain private NPC thought. */
  diagnostic: string;
  details?: Record<string, unknown>;
  retryable: boolean;
}

export type SettlementWarningCode =
  | "value_clamped"
  | "mechanic_removed"
  | "kind_downgraded"
  | "legacy_normalized";

export interface SettlementWarning {
  code: SettlementWarningCode;
  message: string;
  details?: Record<string, unknown>;
  /** True when candidate narration may need correction before display. */
  narrationRelevant: boolean;
}
```

Rules:

- rejection and warning codes are stable API values;
- diagnostics are for Pi/private audit/development, not automatically shown to the player;
- `retryable` means a fresh observation or corrected payload may succeed;
- clamping/sanitizing must be explicit as a warning, never silent;
- an accepted Decision with warnings still commits exact accepted events.

### 3.3 Decision

```ts
export type Decision<TResult = unknown, TEvent extends WorldEvent = WorldEvent> =
  | {
      accepted: true;
      result: TResult;
      events: readonly [TEvent, ...TEvent[]];
      warnings: SettlementWarning[];
    }
  | {
      accepted: false;
      rejection: SettlementRejection;
      events: readonly [];
      warnings: readonly [];
    };
```

Contract rules:

- an accepted Decision contains at least one WorldEvent;
- a semantic no-op is rejected with `already_applied` or `precondition_failed`;
- idempotent retry by the **same proposalId** is handled by the transaction store and returns the prior Settlement instead of deciding again;
- Decider is pure with respect to I/O and external Agent calls;
- Decider may use world-pack definitions already present in State/context but may not mutate them.

### 3.4 Settlement result

```ts
export type Settlement<TResult = unknown> =
  | {
      accepted: true;
      transactionId: string;
      proposal: ProposalEnvelope<unknown>;
      result: TResult;
      revisionBefore: number;
      revisionAfter: number;
      turn: number;
      committedEvents: readonly CommittedWorldEvent[];
      warnings: SettlementWarning[];
      /** In-memory prepared State. Never serialized into the journal. */
      nextState: WorldState;
    }
  | {
      accepted: false;
      transactionId: string;
      proposal: ProposalEnvelope<unknown>;
      revisionBefore: number;
      revisionAfter: number;
      turn: number;
      committedEvents: readonly [];
      rejection: SettlementRejection;
      warnings: readonly [];
    };
```

For rejection, `revisionAfter === revisionBefore`.

---

## 4. WorldEvent and commit metadata

### 4.1 Domain events contain replay facts, not request metadata

```ts
export type WorldEvent =
  | PlayerMoved
  | PlayerSpoke
  | RoomCreated
  | RoomExitSet
  | RoomDescriptionChanged
  | RoomExplorationRecorded
  | ItemCreated
  | ItemTransferred
  | ParameterChanged
  | LifecycleChanged
  | NpcCreated
  | NpcMoved
  | NpcDefeated
  | WorldFactAdded
  | WorldFactRemoved
  | PlotThreadChanged
  | ConflictStarted
  | ObjectiveCompleted
  | StoryOutcomeReached
  | TurnAdvanced;
```

Proposal source, transaction ID, revisions and correlation metadata live in committed envelopes, not repeated in each domain payload.

```ts
export interface CommittedWorldEvent<TEvent extends WorldEvent = WorldEvent> {
  eventId: string;
  transactionId: string;
  index: number;
  revision: number;
  turn: number;
  source: ProposalSource;
  correlationId: string;
  causationId?: string;
  event: TEvent;
}
```

Initial `eventId` rule:

```text
${transactionId}:${index}
```

The journal persists a transaction envelope containing the event payload array plus shared metadata; `CommittedWorldEvent` may be materialized for projection.

### 4.2 Initial event shapes

The first migration wave freezes these shapes conceptually. Exact imported entity snapshot types may be named aliases.

```ts
export interface PlayerMoved {
  kind: "player_moved";
  playerId: string;
  fromRoomId: string;
  toRoomId: string;
}

export interface PlayerSpoke {
  kind: "player_spoke";
  playerId: string;
  roomId: string;
  message: string;
  targetId?: string;
}

export interface RoomCreated {
  kind: "room_created";
  room: RoomDef;
}

export interface RoomExitSet {
  kind: "room_exit_set";
  roomId: string;
  direction: string;
  beforeToRoomId?: string;
  afterToRoomId: string;
}

export interface RoomDescriptionChanged {
  kind: "room_description_changed";
  roomId: string;
  before: string;
  after: string;
}

export interface RoomExplorationRecorded {
  kind: "room_exploration_recorded";
  roomId: string;
  discoveredBefore: boolean;
  discoveredAfter: true;
  visitedTurnBefore?: number;
  visitedTurnAfter: number;
}

export interface ItemCreated {
  kind: "item_created";
  item: ItemDef;
}

export interface ItemTransferred {
  kind: "item_transferred";
  itemId: string;
  from: ItemLocation;
  to: ItemLocation;
}

export interface ParameterChanged {
  kind: "parameter_changed";
  entityId: string;
  parameterId: string;
  before: number;
  after: number;
  cause: string;
}

export interface LifecycleChanged {
  kind: "lifecycle_changed";
  entityId: string;
  before: "active" | "incapacitated" | "dead";
  after: "active" | "incapacitated" | "dead";
  cause: string;
}

export interface NpcCreated {
  kind: "npc_created";
  npc: NpcDef;
}

export interface NpcMoved {
  kind: "npc_moved";
  npcId: string;
  fromRoomId: string;
  toRoomId: string;
}

export interface NpcDefeated {
  kind: "npc_defeated";
  npcId: string;
  roomId: string;
}

export interface WorldFactAdded {
  kind: "world_fact_added";
  fact: WorldFact;
}

export interface WorldFactRemoved {
  kind: "world_fact_removed";
  fact: WorldFact;
}

export interface PlotThreadChanged {
  kind: "plot_thread_changed";
  plotId: string;
  before?: PlotThread;
  after: PlotThread;
}

export interface ConflictStarted {
  kind: "conflict_started";
  actorId: string;
  targetId: string;
  roomId: string;
}

export interface ObjectiveCompleted {
  kind: "objective_completed";
  objectiveId: string;
  completedTurn: number;
  reason?: string;
}

export interface StoryOutcomeReached {
  kind: "story_outcome_reached";
  outcome: ReachedOutcome;
}

export interface TurnAdvanced {
  kind: "turn_advanced";
  before: number;
  after: number;
}
```

### 4.3 Event design rules

1. Event kinds never carry `engine/` or `dm/` prefixes; source is metadata.
2. Events contain IDs and exact snapshots/values required for deterministic replay.
3. `parameter_changed` never stores only delta.
4. Lifecycle changes caused by thresholds are separate explicit events.
5. Equipping an item uses ordered `item_transferred` events:
   - old equipped item → inventory;
   - new inventory item → equipped.
   Reducer updates both item location and `player.equipment` from those exact locations.
6. Moving into a newly discovered room produces `player_moved` plus `room_exploration_recorded` in one transaction.
7. Player speech is a committed fact even though `evolve()` has no persistent field to change for it.
8. Presentation frames are not automatically WorldEvents. A conflict transaction stores authoritative parameter/lifecycle/defeat facts; presentation data belongs in `Decision.result` and Turn/UI projection unless future replay requirements prove otherwise.
9. WorldEvent payloads must be structured-cloneable and JSON-serializable.
10. Room descriptions and plot threads store exact `before/after`; reducers never append or merge ambiguous prose on replay.
11. `conflict_started` is an authoritative action marker with no direct State field change; typed conflict settlement may emit it with exact parameter/lifecycle/defeat events in one transaction.
12. The initial catalog covers all current Mutation behavior so the legacy adapter never needs to treat a Mutation itself as a committed fact.

---

## 5. Decider contract

```ts
export type Decider<TProposal, TResult = unknown> = (
  state: Readonly<WorldState>,
  proposal: ProposalEnvelope<TProposal>,
  context: Readonly<DecisionContext>
) => Decision<TResult>;

export interface DecisionContext {
  storyOutcomes: readonly StoryOutcomeDef[];
  /** Trusted resolver selected from the loaded world pack, if required. */
  conflictResolver?: ConflictResolver;
}
```

Rules:

- read-only State is passed as a structured clone or recursively readonly view;
- no filesystem, network, Pi Session or UI calls inside Decider;
- no `Math.random()`; use proposal result or Engine/world-script seeded tools;
- permission checks use `proposal.source`;
- every entity, room, parameter, template, ownership and precondition reference is validated;
- a proposed delta is converted to exact before/after and an explicit warning if clamped;
- dependent events are computed against an in-memory draft evolved in event order;
- Decider never writes `state.revision` or `state.turn` directly.

### 5.1 Source permissions

Initial policy:

| Operation | player | dm | npc | engine | world_script |
|---|---:|---:|---:|---:|---:|
| move player from a validated command | yes | proposal only through allowed GM operation | no | yes | no |
| move independently controlled NPC | no | no | self only | yes | only if explicitly authorized |
| create room/item/NPC | no | yes within schema/budget | no | yes | only returned through validated host operation |
| transfer player-owned item | validated player action | allowed GM grant only | self grant via reward template | yes | validated effect only |
| change parameters | validated action result | allowed GM consequence | self/target only when policy permits | yes | validated effect only |
| complete deterministic objective | no | semantic-only if world allows | no | yes | no |
| reach StoryOutcome | no | declared outcome only | no | yes for deterministic lifecycle policy | no |

This table is deny-by-default. Domain deciders may narrow permissions further.

---

## 6. Evolve contract

```ts
export function evolve(state: WorldState, event: WorldEvent): void;
```

`evolve()`:

- performs no permissions, stale, semantic or range decisions;
- does not clamp;
- does not silently return;
- may assert exact `before` values and locations;
- throws `EventInvariantError` when a committed event cannot apply exactly;
- is deterministic and contains no I/O;
- updates redundant indexes, such as player inventory/equipment, from the event in one reducer step;
- does not increment revision; transaction commit sets `revisionAfter` after all events evolve;
- does not infer threshold effects—those arrive as explicit lifecycle events.

Examples of invariant failures:

- `parameter_changed.before` differs from current value;
- `item_transferred.from` differs from current location;
- an item ID already exists for `item_created`;
- `player_moved.fromRoomId` differs from current player room;
- an objective is already completed when replaying a new completion event;
- transaction revision sequence is broken.

These failures indicate corrupt journal data or an Engine bug, not a player-facing rejection.

---

## 7. Prepare, commit and idempotency

### 7.1 Pure preparation

```ts
prepareSettlement(state, proposal, decider, context): Settlement
```

Preparation steps:

1. verify exact expected revision;
2. call pure Decider;
3. if rejected, return rejected Settlement;
4. clone State;
5. evolve every decided event into the clone;
6. set clone revision to `revisionBefore + 1`;
7. materialize committed event envelopes;
8. return accepted Settlement with `nextState`.

No persistent write or post-commit effect occurs during preparation.

### 7.2 Commit

Phase 1 in-memory compatibility commit:

1. prepare successfully;
2. replace the live State contents from `nextState` while retaining the live root object identity required by current adapters;
3. return accepted Settlement;
4. run post-commit projection/effects.

Phase 6 durable commit:

1. prepare successfully;
2. append and flush checksummed transaction to `world-events.jsonl`;
3. replace live State with prepared State;
4. atomically update snapshot;
5. enqueue/execute idempotent outbox effects.

### 7.3 Idempotency

- transaction storage indexes `proposalId`;
- re-submitting an already committed `proposalId` returns the original accepted Settlement;
- re-submitting an already rejected proposal may return the prior rejection within the bounded audit lifetime, but must never create an event merely because revision changed;
- a different proposal ID with equivalent payload is a new request and goes through normal precondition checks;
- outbox IDs derive from transaction ID and effect index.

---

## 8. Public projection contract

```ts
export function projectPublicEvents(
  event: CommittedWorldEvent,
  context?: PublicProjectionContext
): GameEvent[];
```

Rules:

- projection consumes committed facts only;
- it never reads a before/after WorldState pair to guess acceptance;
- it does not mutate State;
- rejected proposals cannot be passed to it;
- private source/session metadata and NPC thought are not exposed;
- transaction event order is preserved;
- a projector may return zero, one or multiple public events.

Examples:

```text
player_moved                    → player_moved
player_spoke                    → player_spoke
item_created(room)              → item_created
item_created(player inventory)  → item_created + item_granted
item_transferred(room→inventory)→ item_picked_up
item_transferred(owned→room)    → item_dropped
item_transferred(owned→destroyed) → item_consumed when cause says use/consume
parameter_changed decreasing    → entity_attacked only when public cause classifies it as harm
lifecycle_changed               → player_died/player_incapacitated
objective_completed             → objective_completed
```

`ParameterChanged.cause` must use a stable machine-readable cause code, not arbitrary prose, so public projection can distinguish harm, healing, cost and GM adjustment.

---

## 9. Post-commit contract

Only accepted committed transactions may trigger:

- Objective evaluation;
- NPC perception;
- DM continuation/correction;
- TurnRecord projection;
- state snapshot;
- UI/TUI/Telnet/GMCP output;
- pending perception/outbox work.

Ordering inside one player turn:

```text
player proposal settlement
→ public projection
→ deterministic objective proposal settlement
→ objective public projection
→ relevant NPC perception and NPC proposal settlement
→ pre-DM public event set
→ Pi DM candidate narration + proposal batch
→ DM batch settlement
→ optional deterministic progress settlement
→ candidate narration validation/correction
→ turn_advanced settlement
→ persist/projections/output
```

An Agent is never invoked from inside `decide()` or `evolve()`.

---

## 10. Legacy adapter contract

```ts
settleLegacyMutation(
  state: WorldState,
  mutation: AnyMutation,
  metadata: LegacyProposalMetadata
): Settlement;
```

The adapter temporarily interprets existing Mutation as Proposal payload. It must:

- assign source from `engine/` vs `dm/` plus caller metadata;
- use current revision as expected revision for synchronous legacy calls;
- return structured rejection instead of relying on `console.warn`;
- generate exact WorldEvents;
- preserve current externally observable behavior under characterization tests;
- never pass an unaccepted legacy Mutation into public projection;
- be removed domain-by-domain as typed Proposals replace Mutations.

Legacy batch application must not pretend to be atomic. It settles each legacy mutation as a separate transaction in order, matching current behavior. New domain operations requiring atomicity must use a single typed Proposal, not `applyMutations()`.

---

## 11. WorldState compatibility

Add:

```ts
export interface WorldState {
  revision: number;
  // existing fields...
}
```

Normalization:

```text
old save without revision → revision = 0
```

This normalization is not itself a world transaction. It is save-format compatibility and may produce a private `legacy_normalized` warning during load diagnostics.

No other WorldState shape change is required for Phase 1.

---

## 12. TurnRecord transition

During compatibility, keep existing fields and add optional settlement data:

```ts
interface TurnRecord {
  // legacy fields remain temporarily
  revisionBefore?: number;
  revisionAfter?: number;
  proposalIds?: string[];
  transactionIds?: string[];
  committedEvents?: CommittedWorldEvent[];
  rejections?: Array<{
    proposalId: string;
    rejection: SettlementRejection;
  }>;
}
```

Rules:

- legacy mutation arrays are compatibility projections, not future authority;
- committedEvents contain only accepted facts;
- private NPC thought and private diagnostics remain excluded;
- Phase 6 Journal becomes authority; TurnRecord remains a player-turn projection.

---

## 13. Required tests before integration

### Decision and revision

- exact revision accepted;
- stale revision rejected;
- rejection leaves State byte-equivalent and revision unchanged;
- successful transaction increments revision once regardless of event count;
- same proposal ID is idempotent.

### Atomicity and evolve

- multi-event equipment replacement is all-or-nothing;
- parameter change plus lifecycle change replays exactly;
- an invariant failure in event N leaves live State unchanged;
- exact `before` mismatch throws `EventInvariantError` during preparation/replay.

### Batch semantics

- stale batch rejects every child before decision;
- accepted child increments revision used by next sibling;
- rejected sibling does not increment revision;
- later sibling may still commit;
- no external proposal interleaves with a locked batch.

### Projection

- rejected proposal produces no GameEvent;
- committed item creation in inventory projects creation and grant;
- create→transfer→consume preserves all intermediate public facts;
- public projection never exposes source session ID or NPC thought.

### Runtime/post-commit

- NPC is not awakened before relevant commit;
- candidate narration is not emitted before DM batch settles;
- failed DM operation receives private structured feedback;
- TurnRecord includes only committed events as facts;
- read-only commands do not increment revision.

### Compatibility

- old save initializes revision 0;
- current built-in worlds load unchanged;
- current commands and AI reward behavior remain covered by characterization tests.

---

## 14. Explicit non-goals of this contract

This contract does not introduce:

- multiplayer concurrency;
- automatic trap, stealth, social or crafting systems;
- a complete condition model;
- ItemDefinition/ItemInstance split;
- SQLite;
- third-party script sandboxing;
- automatic NPC schedules;
- durable Journal implementation in Phase 1;
- conflict renderer generalization.

It only establishes the trustworthy digital-table boundary needed for those features when real world-pack demand exists.

---

## 15. Approval checklist

Before tasks #41–#43 begin in parallel, confirm:

- [ ] Pi is the semantic GM; Engine validates table operations rather than replacing the GM.
- [ ] One Proposal is one atomic domain operation.
- [ ] One DM response is an ordered batch of independent proposal transactions.
- [ ] Batch stale revision is checked once; sibling transactions advance revision internally.
- [ ] Accepted Decisions require at least one exact WorldEvent.
- [ ] Rejected and no-op proposals do not increment revision.
- [ ] Threshold/lifecycle results are explicit events, not reducer inference.
- [ ] Candidate narration is buffered until settlement succeeds.
- [ ] Public GameEvent is projected only from committed WorldEvent.
- [ ] Legacy adapter is temporary and migrated by vertical domain.
- [ ] Phase 1 keeps JSON snapshots; durable Event Journal waits for Phase 6.
