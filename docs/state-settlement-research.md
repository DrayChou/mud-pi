# 权威状态结算内核调研

> 目标：为 `mud-pi` 设计一次深层、可迁移、可审计的状态变更重构，而不是只给 `applyMutation()` 增加一个布尔返回值。

## 1. 当前问题的本质

当前 `AnyMutation` 同时承担了三种职责：

1. **提案/命令**：`engine/item_picked_up` 仍需检查物品是否在当前房间；
2. **校验入口**：`applyMutation()` 在写状态前判断权限、位置、实体存在性和 stale；
3. **事实记录**：事件层又把同一个 Mutation 当作“已经发生的事实”来派生 `GameEvent`。

因此 Mutation 并不是真正的事实。它更接近一个需要裁决的 Command，但名称和调用方式把它伪装成了已经可以应用的状态变更。

这会造成：

- 调用方无法明确知道 Mutation 是否被接受；
- `deriveGameEvents(before, mutations, after)` 只能从快照猜测哪些提案真正生效；
- 同批次“创建 → 拾取 → 使用”使最终快照丢失中间事实；
- TurnRecord 混合保存提案与权威结算；
- 被拒绝的 AI 输出缺少结构化反馈；
- `turn` 被迫承担 stale token，但一个回合内已经存在多个结算阶段；
- 状态快照与 `turns.jsonl` 不是原子提交，崩溃时可能不一致。

调研结论是：**仅将 `applyMutation(): void` 改为 `applyMutation(): Result` 只能缓解症状，不能解决“提案与事实混用”的根问题。**

---

## 2. 开源方案调研

## 2.1 Akka Persistence：Command 决定 Effect，Event 唯一修改 State

Akka 的 `EventSourcedBehavior` 明确分成两部分：

- command handler 接收当前 State 和 Command，返回要持久化哪些 Event 的 `Effect`；
- event handler 只在 Event 成功持久化后更新 State；
- 多个 Event 原子持久化，要么全部成功，要么全部失败；
- side effect 通过 `thenRun` 在持久化成功后执行。

官方文档的核心说明见：

- [command handler 返回 persist/none Effect；多事件原子持久化](https://github.com/akka/akka/blob/e75e809380ee16a18b12007d69bb46c30b9230e7/akka-docs/src/main/paradox/typed/persistence.md#L142-L159)
- [State 只能由成功持久化后的 event handler 修改](https://github.com/akka/akka/blob/e75e809380ee16a18b12007d69bb46c30b9230e7/akka-docs/src/main/paradox/typed/persistence.md#L161-L170)

其账户示例非常接近我们的需求：余额足够时产生 `Withdrawn` Event，不足时直接返回结构化错误，不会先修改状态再回滚：

- [Withdraw：persist Event 或 reply Error](https://github.com/akka/akka/blob/e75e809380ee16a18b12007d69bb46c30b9230e7/akka-cluster-sharding-typed/src/test/scala/docs/akka/cluster/sharding/typed/AccountExampleWithCommandHandlersInState.scala#L72-L96)

**对 mud-pi 的启示：**

```text
Agent/玩家 Proposal
  → decide(State, Proposal)
  → Accepted(WorldEvent[]) | Rejected(Error)
  → 先提交 WorldEvent
  → evolve(State, WorldEvent)
  → 提交成功后才唤醒 NPC、输出 UI、写投影
```

不应让一个还可能被拒绝的 Mutation 直接进入 State reducer。

---

## 2.2 Equinox Decider：State → Result + Events，并处理并发冲突

Equinox 的 Decider 接口把领域决策表达为：

```text
state → result * events[]
```

然后尝试同步 Event；若发生版本冲突，重新读取最新状态并重跑 decision：

- [Decider.Transact：decision 同时返回 result 与 events](https://github.com/jet/equinox/blob/9c8e8a7797bf74726502ba036ee6577cdabed424/src/Equinox/Decider.fs#L22-L45)
- [sync 成功则返回；冲突则加载新状态并重跑 decide](https://github.com/jet/equinox/blob/9c8e8a7797bf74726502ba036ee6577cdabed424/src/Equinox/Stream.fs#L34-L54)

这是比“MutationApplyResult”更完整的模型：

```ts
Decision = {
  result: DomainResult;
  events: WorldEvent[];
}
```

对于拒绝，可以返回：

```ts
{
  result: { accepted: false, rejection },
  events: []
}
```

**对 mud-pi 的启示：**

- `requestedAtTurn` 应泛化为 `expectedRevision`；
- DM、NPC、冲突脚本的提案都携带权威状态版本；
- `turn` 是叙事时间，不应再兼任并发版本；
- 当前 Runtime 虽然串行，但未来 Telnet/Web、多 NPC 并发和异步 Agent 都需要 revision。

---

## 2.3 Eventuous：Aggregate 保存 pending Events，Result 明确区分成功和错误

Eventuous 的 Aggregate 不让外部直接修改 State。领域操作通过 `Apply(event)`：

1. 把 Event 放入 pending changes；
2. 用 `State.When(event)` 更新状态；
3. `Changes` 和版本明确记录本次操作产生了哪些新事实。

参见：

- [Aggregate 的 Original、Changes 和版本模型](https://github.com/Eventuous/eventuous/blob/7827d2f971bac60249b231413e7b77e6d511fc40/src/Core/src/Eventuous.Domain/Aggregate.cs#L8-L47)
- [Apply：先记录 Event，再通过 State.When 演化状态](https://github.com/Eventuous/eventuous/blob/7827d2f971bac60249b231413e7b77e6d511fc40/src/Core/src/Eventuous.Domain/Aggregate.cs#L67-L88)

其应用层 `Result<TState>` 明确表示：

- 成功：新 State + Changes + 全局位置；
- 失败：Exception/ErrorMessage。

参见：

- [Result 表示 command handling success 或 error](https://github.com/Eventuous/eventuous/blob/7827d2f971bac60249b231413e7b77e6d511fc40/src/Core/src/Eventuous.Application/Result.cs#L20-L69)
- [失败结果和 Match API](https://github.com/Eventuous/eventuous/blob/7827d2f971bac60249b231413e7b77e6d511fc40/src/Core/src/Eventuous.Application/Result.cs#L71-L120)

**对 mud-pi 的启示：**

TurnRecord 应保存：

```text
Proposal
Decision Result
Committed WorldEvents
Revision
```

而不是只保存一组语义模糊的 `dmMutations`。

---

## 2.4 boardgame.io：权威 stateID、INVALID_MOVE 和草稿事务回滚

boardgame.io 是最接近当前 TypeScript 游戏状态 reducer 的案例。

它定义了明确的错误分类，包括：

- stale state ID；
- unavailable move；
- invalid move；
- inactive player；
- game over；
- plugin invalid。

参见 [ActionErrorType](https://github.com/boardgameio/boardgame.io/blob/55200a6aead258d94601093572b6fafde44058b1/src/core/errors.ts#L18-L34)。

服务器在执行行动前检查客户端提交的 `_stateID`；版本不匹配就拒绝，不让过期动作进入 reducer：

- [服务端 stale stateID 校验](https://github.com/boardgameio/boardgame.io/blob/55200a6aead258d94601093572b6fafde44058b1/src/master/master.ts#L280-L307)

Move 返回 `INVALID_MOVE` 时，reducer 保留旧状态并附加结构化错误：

- [处理 INVALID_MOVE 并返回旧状态](https://github.com/boardgameio/boardgame.io/blob/55200a6aead258d94601093572b6fafde44058b1/src/core/reducer.ts#L368-L410)

更重要的是，它使用 Immer draft 执行 move。即使 move 已经修改 draft，最后返回 `INVALID_MOVE`，整个 draft 仍会被丢弃：

- [Immer wrapper 对 INVALID_MOVE 做事务式丢弃](https://github.com/boardgameio/boardgame.io/blob/55200a6aead258d94601093572b6fafde44058b1/src/plugins/plugin-immer.ts#L9-L35)

**对 mud-pi 的启示：**

- AI proposal 应有 `expectedRevision`；
- 一条领域命令必须 all-or-nothing；
- 可以用 clone/draft 在内存中预演，但不能把“草稿修改成功”当作权威事实；
- 错误码必须进入结算结果，不能只有 `console.warn`。

boardgame.io 的不足是 `INVALID_MOVE` 本身信息量较低，源码中甚至留有“marshal a nice error payload”的 TODO。因此 mud-pi 应直接采用结构化 Rejection，而不是单一 sentinel。

---

## 2.5 Battle for Wesnoth：同步命令、成功标志、Replay 与 Undo

Wesnoth 的同步命令 handler 返回 `bool` 表示执行是否成功：

- [synced command handler 的成功返回协议](https://github.com/wesnoth/wesnoth/blob/d2f4a7e12df26932bbb0a4c9a4c1d840ca8a4df4/src/synced_commands.hpp#L44-L77)

执行同步命令时，它先初始化 action/undo 上下文；handler 失败则返回 false。录制流程会先把 command 写入 replay recorder，失败时撤销 recorder 记录，成功时清理 action：

- [run：执行 handler 并完成 action checkup](https://github.com/wesnoth/wesnoth/blob/d2f4a7e12df26932bbb0a4c9a4c1d840ca8a4df4/src/synced_context.cpp#L47-L78)
- [run_and_store：失败撤销 replay command，成功提交 action](https://github.com/wesnoth/wesnoth/blob/d2f4a7e12df26932bbb0a4c9a4c1d840ca8a4df4/src/synced_context.cpp#L81-L96)

**对 mud-pi 的启示：**

- 权威日志不能记录失败 proposal 为已执行动作；
- replay/journal 与实际状态提交需要一致；
- 仅有 bool 不足以支撑 AI 修正和审计，应保留结构化错误；
- Undo 方案适合复杂命令式旧引擎，但新代码更适合 Akka/Equinox 的“先决定 Event，再演化 State”。

---

## 2.6 Evennia：先做批量 preflight，再执行命令式移动

Evennia 的 `get` 命令先搜索全部对象，对全部对象执行 access 和 `at_pre_get`；任一对象不允许拾取就直接取消。验证完成后才逐个 `move_to`，并单独记录实际移动成功的对象：

- [CmdGet 的 preflight 和 moved 结果收集](https://github.com/evennia/evennia/blob/0c677ae652422db397519ee80afc6cf2d6f52c2b/evennia/commands/default/general.py#L437-L482)

这是成熟 MUD 的实用模式：

```text
先验证整个目标集合
→ 再执行副作用
→ 只公布实际成功的对象
```

但它仍是命令式状态修改，可能出现部分移动成功，不适合作为 mud-pi 面向多个异步 AI 的最终权威结算模型。

可以借鉴其 **preflight**，但底层应采用 Event/Decision，而不是继续扩展直接 mutation。

---

## 3. 方案比较

| 方案 | 拒绝是否显式 | 状态是否只由事实更新 | 批次原子性 | stale/version | 适合 AI 审计 |
|---|---:|---:|---:|---:|---:|
| 当前 mud-pi Mutation | 否 | 否 | 否 | 仅部分用 turn | 弱 |
| `applyMutation(): Result` 补丁 | 是 | 否 | 可选 | 可加 | 中 |
| Evennia preflight | 部分 | 否 | 部分 | 无 | 中 |
| boardgame.io reducer | 是 | 否，move 可改 draft | 单 move 原子 | stateID | 中高 |
| Wesnoth synced command | bool | 否 | action/undo | replay context | 中 |
| Eventuous Aggregate | 是 | 是 | pending changes | aggregate version | 高 |
| Akka EventSourcedBehavior | 是 | 是 | 多事件原子 | sequence/persistence | 高 |
| Equinox Decider | 是 | 是 | transaction | token/version + retry | 很高 |

## 结论

最适合 mud-pi 的不是单独照搬某一个库，而是组合：

- **Akka**：Command/Effect/Event/State 和 post-commit side effect 边界；
- **Equinox**：`state → result + events` 的纯 Decider 与 revision conflict；
- **Eventuous**：Changes、Result 和可审计 Aggregate 结果；
- **boardgame.io**：游戏级 state revision、stale action 和事务式草稿；
- **Evennia**：多对象动作的 preflight；
- **Wesnoth**：权威 replay 只保留成功 action 的原则。

---

## 4. 推荐的底层模型：Authoritative Settlement Kernel

## 4.1 五层边界

```text
Intent / Proposal（不可信）
        ↓
Decider（纯校验与决策）
        ↓
Decision：Accepted(WorldEvent[]) | Rejected(Rejection)
        ↓
Commit + Evolve（权威事实提交和状态演化）
        ↓
Projection / Post-Commit Effects（GameEvent、Objective、NPC、UI、日志）
```

### Proposal

所有来源统一为 proposal：

```ts
interface ProposalEnvelope<TProposal> {
  proposalId: string;
  correlationId: string;
  causationId?: string;

  source: {
    kind: "player" | "dm" | "npc" | "engine" | "world_script";
    id: string;
  };

  expectedRevision: number;
  proposedAtTurn: number;
  payload: TProposal;
}
```

玩家命令、DM 世界更新、NPC Intent、Objective 结算和世界脚本 effects 都不能直接成为 WorldEvent。

### Decision

```ts
type Decision<TResult = unknown> =
  | {
      accepted: true;
      result?: TResult;
      events: WorldEvent[];
      warnings?: SettlementWarning[];
    }
  | {
      accepted: false;
      rejection: SettlementRejection;
      events: [];
    };
```

```ts
interface SettlementRejection {
  code:
    | "stale_revision"
    | "entity_not_found"
    | "duplicate_entity"
    | "invalid_location"
    | "invalid_parameter"
    | "invalid_value"
    | "permission_denied"
    | "precondition_failed"
    | "unsupported_operation";

  safeMessage?: string;
  diagnostic: string;
  details?: Record<string, unknown>;
}
```

### WorldEvent

WorldEvent 是已经经过裁决的客观事实，应包含足以 replay 的确定值：

```ts
type WorldEvent =
  | {
      kind: "player_moved";
      playerId: string;
      fromRoomId: string;
      toRoomId: string;
    }
  | {
      kind: "item_spawned";
      item: ItemDef;
    }
  | {
      kind: "item_transferred";
      itemId: string;
      from: ItemLocation;
      to: ItemLocation;
    }
  | {
      kind: "parameter_changed";
      entityId: string;
      parameterId: string;
      before: number;
      after: number;
      cause: string;
    }
  | {
      kind: "entity_defeated";
      entityId: string;
    };
```

不要让 Event 再携带需要 reducer 重新解释的模糊 delta。例如脚本提案可以使用 delta，但 Decider 应将它解析成带 `before/after` 的确定 Event。

### Evolve

```ts
function evolve(state: WorldState, event: WorldEvent): void
```

`evolve()` 应当是 total reducer：

- 不做业务权限判断；
- 不静默拒绝；
- 不返回 false；
- Event 与 State 不一致意味着 Engine bug，应抛错并中止整个 transaction；
- 同一组 committed Events 必须可以从相同初始 State 重放出相同结果。

### Settlement

```ts
interface Settlement<TResult = unknown> {
  transactionId: string;
  proposal: ProposalEnvelope<unknown>;

  revisionBefore: number;
  revisionAfter: number;

  decision: Decision<TResult>;
  committedEvents: WorldEvent[];
}
```

---

## 4.2 Revision 不等于 Turn

新增：

```ts
interface WorldState {
  turn: number;
  revision: number;
}
```

- `turn`：玩家和叙事时间；
- `revision`：每次成功权威 transaction 递增；
- AI proposal 使用 `expectedRevision`；
- TurnRecord 可包含多个 revision；
- rejected proposal 不递增 revision；
- read-only command 不递增 revision。

DM 和 NPC prompt 应记录：

```text
权威状态版本：revision 42
```

Agent 返回 proposal 时必须携带同一个 revision。版本不同则返回 `stale_revision`，必要时重建 Prompt 重试，而不是应用过期结果。

---

## 4.3 原子性单位

不能把一个 DM `<WORLD_UPDATE>` 中所有提案无条件绑成一个大事务，否则一个坏 alias 会导致整个剧情更新失败。

推荐两级结构：

```text
ProposalBatch（同一 Agent 响应）
  ├── Transaction A：新增房间
  ├── Transaction B：新增出口
  ├── Transaction C：新增道具
  └── Transaction D：StoryOutcome
```

每个领域操作单独 settle，按固定顺序执行；一个操作内部产生的多个 WorldEvent 必须原子提交。

例如装备替换应是一个 transaction：

```text
旧装备 equipped → inventory
新装备 inventory → equipped
装备槽引用更新
```

不能只成功一半。

冲突模拟也应是单 transaction，所有 parameter changes、defeat 和 item effects 要么全部提交，要么全部不提交。

---

## 4.4 GameEvent 变成 WorldEvent 的公共投影

当前：

```text
Mutation + before/after → 猜 GameEvent
```

目标：

```text
Committed WorldEvent → projectPublicEvents() → GameEvent
```

```ts
function projectPublicEvents(event: WorldEvent): GameEvent[]
```

例如：

```text
item_spawned(room)
  → item_created

item_spawned(inventory)
  → item_created + item_granted

item_transferred(room → inventory)
  → item_picked_up
```

这样不再需要扫描最终快照判断某个 proposal 是否生效。

Objective、NPC 可见事件、DM 回顾和 UI 都只消费 committed WorldEvent 的投影。

---

## 4.5 Post-Commit Effects / Outbox

以下行为只能在 commit 成功后发生：

- 保存 state snapshot；
- 写 TurnRecord projection；
- 唤醒 NPC；
- 发送 Telnet/GMCP；
- 更新 TUI；
- 触发 DM 后续修正；
- 清理 pending NPC perceptions。

建议 Settlement 产生 outbox：

```ts
interface PostCommitEffect {
  id: string;
  transactionId: string;
  kind: "npc_perception" | "ui_output" | "turn_projection";
  payload: unknown;
}
```

Effect 使用稳定 ID，消费方需要幂等。这样进程在 commit 后、NPC 唤醒前崩溃，读档后仍能继续处理 pending effect。

---

## 5. 持久化建议

## 5.1 不建议继续把 state.json 与 turns.jsonl 当作两个独立权威写入

当前顺序是：

```text
saveState(state)
appendTurn(turn)
```

若进程在两步之间崩溃，会得到：

```text
state.json 已前进
turns.jsonl 缺少该回合
```

反向顺序也有对应问题。

## 5.2 推荐短期方案：World Event WAL + Snapshot

新增：

```text
saves/{worldId}/world-events.jsonl
```

每行是完整 transaction envelope：

```json
{
  "transactionId": "tx_...",
  "revisionBefore": 41,
  "revisionAfter": 42,
  "proposal": {},
  "decision": { "accepted": true },
  "events": [],
  "checksum": "..."
}
```

提交流程：

```text
1. decide，得到 WorldEvent[]
2. 在内存 draft 上 evolve 全部 Event，确认不会失败
3. append transaction 到 world-events.jsonl
4. flush/fsync（可配置）
5. 用 draft 替换内存 State
6. state.json.tmp → atomic rename 为 state.json
7. 执行 outbox/projectors
```

恢复流程：

```text
1. 读取 state.json 的 revision
2. 校验 world-events.jsonl 的完整行和 checksum
3. 重放 revision > snapshot.revision 的 transaction
4. 重写 snapshot
5. 恢复未完成 outbox
```

最后一条 JSONL 若因崩溃不完整，可以安全截断；已完整写入但 snapshot 未更新的 Event 可以重放。

## 5.3 中期可选方案：bun:sqlite

如果后续需要：

- 多客户端并发；
- 大量 NPC pending perception；
- 世界事件检索；
- 原子保存 event、snapshot、outbox 和 turn projection；
- 存档修复工具；

可以使用 `bun:sqlite`：

```text
transactions
world_events
snapshots
outbox
turn_projections
```

这不会替代 Pi Session，也不是重复实现 Agent 长期记忆数据库；它只存客观权威世界结算。

当前阶段建议先用 JSONL WAL 完成领域边界，再决定是否迁移 SQLite，避免同时承担领域模型和存储引擎两项大改造。

---

## 6. 迁移策略：不要 Big Bang

## Phase 0：Characterization Tests

先冻结当前行为：

- 每种 Mutation 的成功状态；
- 每种拒绝条件；
- 同批次依赖顺序；
- 事件输出；
- Objective；
- 生命周期 threshold；
- combat/item script effects；
- 旧存档迁移。

增加 replay determinism 测试：

```text
initial state + committed events
===
current state
```

## Phase 1：引入类型，但保留兼容 Adapter

新增：

```text
src/types/proposals.ts
src/types/world-events.ts
src/engine/decide.ts
src/store/evolve.ts
src/store/settlement.ts
```

旧 `EngineMutation/DmMutation` 暂时作为 Proposal payload，不立即删除。

```ts
function settleLegacyMutation(state, mutation): Settlement
```

GameRuntime 开始消费 Settlement，但外部接口暂时不变。

## Phase 2：先迁移物品与移动垂直切片

优先迁移：

- player_moved；
- item_added；
- item_picked_up；
- item_dropped；
- item_equipped；
- item_consumed。

这些正是当前 before/after 推断最复杂的区域。

完成后删除对应 `applyEngine/applyDm` 分支，将它们改为 Decider + WorldEvent + Evolve。

## Phase 3：迁移参数、NPC、Objective 和 Outcome

- parameter proposal → exact before/after event；
- NPC 权限检查进入 Decider；
- Objective completion 成为 committed fact；
- Outcome stale 使用 expectedRevision；
- 生命周期变化由 parameter event 演化后生成后继 transaction，或在同一 decision 中产生 lifecycle event。

## Phase 4：World Event Journal

- revision；
- transaction envelope；
- JSONL WAL；
- snapshot replay；
- checksum；
- crash recovery tests。

## Phase 5：Post-Commit Outbox

- NPC pending perception；
- TurnRecord projection；
- UI/GMCP projection；
- parser warnings；
- 幂等 effect ID。

## Phase 6：删除 Legacy Mutation

所有调用点迁移完成后：

- 删除 `applyMutation()` 中的业务校验；
- `evolve()` 成为唯一 State reducer；
- `deriveGameEvents(before, mutations, after)` 改成 `projectPublicEvents(events)`；
- TurnRecord 不再把 proposal 命名为 mutation；
- `console.warn + return` 全部替换为结构化 Rejection。

---

## 7. 不推荐的方案

### 只给 applyMutation 返回 boolean

问题：

- 无错误码；
- Mutation 仍然同时是 Command 和 Event；
- 无 revision；
- 无原子 transaction；
- 无 replay 边界；
- 无 post-commit 边界。

### 只使用 structuredClone 后尝试应用

这类似 boardgame.io 的 draft transaction，适合兼容迁移，但如果没有 Proposal/Event 分离，仍无法得到长期稳定的审计模型。

可以作为 Settlement 内部的安全预演手段，不能作为最终领域架构。

### 每个 rejected Mutation 都写成 GameEvent

拒绝不是世界事实。它可以写入 audit/settlement log，但不能进入 NPC 可见事件、Objective 或故事事实。

### 立即把整个项目改成完整 Event Sourcing

风险过大，会同时影响 Runtime、存档、测试、DM、NPC、Adapter 和旧存档。

应先建立 Decider/Settlement/Evolve 边界，再逐领域迁移，最后让 Event Journal 成为权威日志。

---

## 8. 最终建议

采用 **Akka + Equinox 风格的 Authoritative Settlement Kernel**：

```text
Proposal
  → Pure Decider
  → Accepted(WorldEvent[]) / Rejected(Rejection)
  → Atomic Commit
  → Evolve State
  → Public Projection
  → Post-Commit Outbox
```

关键原则：

1. Agent 只产生 Proposal；
2. Proposal 永远不是事实；
3. WorldEvent 只能由 Engine Decider 产生；
4. State 只能由 `evolve(WorldEvent)` 修改；
5. GameEvent 只能从 committed WorldEvent 投影；
6. rejected proposal 进入审计日志，不进入世界事件；
7. revision 与 turn 分离；
8. 一条领域命令的多个 Event 原子提交；
9. NPC、UI、TurnRecord 都属于 post-commit；
10. WorldState snapshot 是 Event Journal 的缓存，而不是唯一无法恢复的事实来源。

这比“Mutation Settlement Result”多走了一步，但正是这一步解决了当前最底层的语义混乱。下一阶段应先实现 Phase 0 和 Phase 1，不应直接大规模重写 `apply.ts`。
