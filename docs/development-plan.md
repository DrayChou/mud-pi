# mud-pi 开发计划

## 1. 产品目标

`mud-pi` 是一个 **单人 Pi-first 叙事 RPG 框架**，其心智模型是一场由 Pi 主持的数字桌游：

- 持久 Pi DM 对应真人 DM，负责理解自由行动、裁定开放情境、管理叙事连续性和推进剧情；
- 重要 NPC 可以拥有独立持久 Pi Session，相当于关键人物的独立主持笔记；
- Engine 对应数字桌面、角色纸、道具卡、棋子、计数器、骰塔和战役记录员，负责权威状态、不变量、提交、存档和可查询投影；
- 世界包对应规则书和冒险模组，提供主题、参数、角色/道具模板、目标、结果边界和可信本地脚本；
- CLI、TUI、Telnet/GMCP 只是玩家查看桌面并向 DM 描述行动的不同界面。

项目不建设多人 MUD Server，也不尝试用代码自动模拟完整世界生态。Pi 与 Engine 的详细边界见 [`docs/pi-role-boundary.md`](pi-role-boundary.md)。

---

## 2. 架构原则

1. **Pi 负责开放语义**：调查、陷阱、机关、潜行、说服、欺骗、创造性方案和剧情意义优先由 Pi 裁定。
2. **Engine 负责权威事实**：位置、参数、生命周期、物品、装备、目标、结果和跨回合 condition 必须经过 Engine 校验。
3. **Agent 只能提出 Proposal**：玩家解释器、DM、NPC、Objective evaluator 和世界脚本都不能直接修改 State。
4. **State 只由 committed Event 演化**：目标链路为 `Proposal → Decision → WorldEvent → Commit → Evolve`。
5. **被拒绝的 Proposal 不是事实**：可以进入审计，但不能进入 GameEvent、NPC 感知、Objective 或 UI。
6. **Post-Commit 才执行副作用**：Pi/NPC 唤醒、TurnRecord、GMCP、snapshot 和 outbox 都只能发生在提交成功后。
7. **代码实现名词和不变量，不穷举动词**：只为高频、跨回合、可查询或会破坏一致性的内容增加通用机制。
8. **世界规则数据驱动**：参数、装备槽、traits、effects、奖励模板、冲突算法和文案由世界包定义。
9. **确定性是裁定工具**：关键冲突、世界脚本和显式骰子可复现；普通开放交互允许 Pi 直接语义判断。
10. **保持单人范围**：不增加多人并发、PvP、公会、在线 Builder、自动刷怪和离线生态模拟。

权威结算设计依据见 [`docs/state-settlement-research.md`](state-settlement-research.md)。

---

## 3. 已完成基础能力

### Pi 与 Agent

- 一个存档对应一个持久 DM Pi Session；
- 重要 NPC 懒加载独立持久 Pi Session；
- DM/NPC Session 使用 Pi 原生 JSONL 和 compaction；
- NPC `say / move / wait / give_item` 受控意图；
- NPC 只接收同房间、定向或移动起终点等可见事件；
- 每回合限制独立 NPC 唤醒预算；
- 私人 `thought` 不进入公开 TurnRecord。

### 世界与状态

- 权威 `WorldState`；
- 房间、出口、探索状态和地图快照；
- 确定性 `seeded-mst-v1` 程序化地图；
- 玩家/NPC 生命周期和世界包 thresholds；
- 物品唯一位置：room、inventory、equipped、destroyed；
- RPG Maker 式基础参数、装备 add/rate、traits 和 effects；
- 世界脚本负责冲突和物品使用算法；
- AI 动态创建场景物品和模板约束的背包奖励。

### 进度与叙事

- 确定性 Objective：访问房间、与 NPC 交谈、获得物品、击败实体；
- Objective 依赖、隐藏和完成状态；
- 世界包 StoryOutcome；
- AI 判断任务奖励，Engine 校验模板、奖励人、冷却、次数和重复领取；
- `objective_completed` 事件在同一轮 NPC 决策前结算。

### Runtime 与 Adapter

- 传输层无关 `GameRuntime`；
- CLI；
- 响应式多面板 TUI；
- Telnet + GMCP；
- 一次性确定性冲突结算和结构化展示帧。

---

## 4. 当前核心技术债

1. `Mutation` 仍混合“请求”和“已发生事实”两种语义；
2. `applyMutation()` 仍以 `console.warn + return` 表示许多拒绝；
3. `deriveGameEvents(before, mutations, after)` 仍依赖快照推断事实；
4. `turn` 仍被部分 stale 校验复用，尚无独立 `revision`；
5. 一次领域操作的多个状态变化尚无正式原子事务边界；
6. `state.json`、`turns.jsonl` 和 Agent 副作用在崩溃边界可能不一致；
7. DM 输出被清洗或拒绝后，缺少结构化反馈；
8. Pi 还缺少一组稳定、通用的“自由裁定结果词汇”；
9. 尚无跨回合通用 condition 容器；
10. 部分命名仍是 `combat_*`，尚未泛化为 `conflict_*`。

---

## 5. 下一阶段路线图

## Phase 0 — Characterization 与契约冻结

目标：在重构前固定现有可观察行为，并批准 Settlement Contract。

### 工作项

- 为 `src/store/apply.ts` 每种 Mutation 增加成功与拒绝 characterization tests；
- 覆盖批次依赖：创建→拾取→使用、装备替换、奖励→背包、Objective→奖励；
- 覆盖 stale outcome、NPC 权限、threshold/lifecycle 和世界脚本结果；
- 固定当前 GameEvent、TurnRecord、NPC 感知和 Runtime 输出行为；
- 定义并人工审阅：
  - `ProposalEnvelope<T>`；
  - `Decision<TResult>`；
  - `SettlementRejection`；
  - `WorldEvent`；
  - `Settlement`；
  - `WorldState.revision`；
  - transaction ID 和 expected revision 规则。

### 验收标准

- 当前全部行为有回归保护；
- Contract 不依赖 D&D、陷阱或具体剧本语义；
- 明确 accepted/rejected/adjusted 的结构；
- 明确一个领域操作产生的 Event 要么全部提交，要么全部失败。

---

## Phase 1 — Authoritative Settlement Kernel

目标：并行引入新内核，但保持现有 Runtime 可运行。

### 新模块

```text
src/types/proposals.ts
src/types/world-events.ts
src/engine/decide.ts
src/store/evolve.ts
src/store/settlement.ts
```

### 工作项

- 新增独立 `revision`；
- 实现纯 `evolve(state, event)`；
- 实现 `settle()`：revision 校验、Decision、原子应用、revision 推进；
- 实现 `settleLegacyMutation()` 兼容层；
- 拒绝结果结构化，不再依赖 `console.warn` 表达业务结果；
- Settlement 返回 committed events、rejections 和结果数据；
- 现有 `applyMutation()` 暂时保留为兼容实现，避免 Big Bang。

### 验收标准

- accepted transaction 可从相同 state + events 确定性重放；
- rejected transaction 不改变 state/revision；
- 批次中任一 Event 无法应用时整批失败；
- 旧存档可加载并初始化 revision；
- Runtime 可通过 legacy adapter 保持现有玩法。

---

## Phase 2 — 垂直迁移与公共投影

目标：先迁移高频且不变量清晰的领域，而不是一次性迁移全部 Mutation。

### 迁移顺序

1. 玩家移动；
2. 物品创建和直接授予；
3. 拾取、丢弃；
4. 装备、使用、消耗；
5. 参数变化和 lifecycle；
6. NPC 移动与奖励；
7. Objective 和 StoryOutcome。

### 公共事件

- 新增 `projectPublicEvents(committedEvents)`；
- GameEvent 只由 committed WorldEvent 投影；
- 删除相应领域对 before/after 猜测的依赖；
- NPC 感知、DM Prompt、TurnRecord、UI 和 GMCP 只消费投影事件；
- stale token 从 `requestedAtTurn` 逐步迁移到 `expectedRevision`。

### 验收标准

- 被拒绝 Proposal 不产生公开事件；
- 相同 committed events 始终产生相同 GameEvent；
- 每迁移一个领域就删除该领域 legacy 快照推断；
- 每个垂直切片拥有 replay test。

---

## Phase 3 — Pi GM 桌面操作协议

目标：让 Pi 像真人 DM 操作角色纸、卡牌、棋子和记录本一样处理陷阱、调查、机关和长尾交互，而无需继续扩张自动 MUD 系统。

### 通用 GM 操作词汇

优先支持：

- 在战役记录本中添加权威 WorldFact / flag；
- 揭示地图信息，或开放/关闭已声明出口；
- 调整角色纸上的参数计数器；
- 从世界包模板创建、发放、转移、消耗或销毁道具卡；
- 合法移动玩家/NPC 棋子；
- 放置可感知信号，如噪音、闪光和公开言语；
- 标记世界包允许的 Objective 完成/失败；
- 标记 StoryOutcome；
- 后续放置/移除通用 condition 标记。

这些 Proposal 是“GM 对数字桌面的操作”，不是陷阱、说服、潜行、机关等自动玩法子系统。Pi 先在语义上完成裁定，再选择需要落桌记录的最小操作集合。

### Pi 输出边界

Pi 负责：

- 理解自由行动；
- 判断成功、部分成功、失败和代价；
- 决定是否需要骰子或世界脚本；
- 创作名称、描述、线索和叙述。

Engine 负责：

- Proposal schema；
- ID、引用、权限、数值和 revision 校验；
- 物品、参数、出口和实体不变量；
- 原子提交；
- 结构化拒绝与修正反馈。

### 验收标准

- 一个没有专用命令的陷阱场景可由 Pi 裁定并安全改变参数/事实/物品；
- Pi 无法创建非法参数、复制物品或绕过位置权限；
- 叙述只确认 committed 结果。

---

## Phase 4 — Structured Adjudication Feedback

目标：消除“Pi 说发生了，但 Engine 实际拒绝了”的叙事分叉。

### 工作项

- 在 Settlement 完成前缓存 Pi `<NARRATION>`，不把候选叙述提前展示为事实；
- DM parser 返回 accepted/rejected/adjusted warning；
- Settlement rejection 使用稳定 code；
- Proposal 被拒绝或修正时，将反馈发回同一个持久 DM Session，并允许最多一次有界同回合修正；
- 纯叙事、无状态 Proposal 的回合无需额外调用；
- 修正仍失败时使用只描述 committed facts 的本地沉浸式 fallback；
- 下一轮 DM Prompt 保留必要的上轮权威修正；
- 对被移除的 modifier/effect/kind 给出结构化原因；
- NPC Proposal 被拒绝时不公开失败动作，但将结果反馈到其私有 Session；
- 增加每回合反馈数量和文本长度限制。

### 验收标准

- 玩家不会看到随后被 Engine 拒绝的候选事实叙述；
- Pi 在同一回合或下一轮能明确知道哪些提案未发生；
- 公共叙述、WorldState 和 GameEvent 不再互相矛盾；
- warning 不泄露 NPC 私有 thought。

---

## Phase 5 — 最小通用 Condition

目标：只补齐必须跨回合保存的状态效果，不建设规则百科。

### 数据模型

```text
ConditionDefinition（世界包）
AppliedCondition（存档实例）
```

最小字段：

- condition ID；
- target/source entity；
- stacks；
- applied revision/turn；
- 可选 remaining turns；
- 世界包 parameter modifiers / traits；
- stacking policy。

### 事件

- `condition_applied`；
- `condition_refreshed`；
- `condition_stack_changed`；
- `condition_removed`；
- `condition_expired`。

### 边界

- “是否中毒、恐惧、流血”由 Pi 或世界脚本判断；
- Engine 只保存、聚合、过期和校验 condition；
- 暂不引入完整世界时钟、天气、疾病模拟或自动生态。

---

## Phase 6 — 持久化、Journal 与 Outbox

目标：使 committed WorldEvent 成为可恢复的权威记录。

### 工作项

- `saves/{worldId}/world-events.jsonl`；
- transaction ID、revision、checksum；
- snapshot 保存 last applied revision；
- 启动时验证并重放 snapshot 之后的事件；
- 原子追加 Event transaction；
- post-commit outbox 记录待执行的 NPC/TurnRecord/snapshot effect；
- 崩溃恢复、重复消费和部分写入测试。

### 验收标准

- `initial state + committed events` 可重建当前 State；
- 重复启动不重复应用 Event；
- Agent 调用失败不回滚已经提交的世界事实；
- snapshot 损坏时能从有效 Journal 恢复或明确失败。

---

## Phase 7 — 收敛与可选增强

只在前述基础稳定后评估：

- `CombatSimulationResult` → 通用 `ConflictResult`；
- `combat_warning/result` → `conflict_warning/result`；
- Objective 少量 `all / any / count` 条件；
- 世界包允许的语义 Objective 完成/失败；
- `ItemDefinition / ItemInstance / quantity`；
- 第三方世界脚本 Worker/子进程沙箱；
- 有实际剧本需求时再加入最小 world time。

这些都不是 Settlement Kernel 的前置条件。

---

## 6. 明确非目标

近期不做：

- 多玩家、PvP、公会和多人并发；
- 自动 NPC 日程和离线世界演化；
- 怪物刷新与刷怪循环；
- 完整陷阱、门锁和机关模拟器；
- 为每种技能、法术和环境动作写专用命令；
- 完整 D&D 职业、法术槽和战术战斗规则；
- 通用经济、制作、采集和生活技能模拟；
- 自动生成无限任务；
- 将所有叙事事实结构化；
- 强制所有自由行为掷骰；
- 与 Pi Session 重复的应用层长期记忆数据库。

---

## 7. 多 Agent 并行开发评估

结论：**可以使用 Agent 并行开发，但必须在 Contract 冻结后，以独立 worktree、Owner Files 和依赖 DAG 进行；Settlement 热点不能让多个 Agent 同时自由修改。**

### 适合并行的工作

1. Characterization tests，可按领域写入不同的新测试文件；
2. Settlement 新类型和纯 `evolve()`，主要写新文件；
3. committed event → public event projection，主要写新模块；
4. Journal/replay 测试和持久化原型；
5. 独立只读 QA、架构审查和 replay 审查；
6. 不同世界包的迁移和内容验证。

### 不适合直接并行的热点

以下文件应由 Integration Agent 独占：

```text
src/types/world.ts
src/types/mutations.ts
src/store/apply.ts
src/runtime/game-runtime.ts
src/engine/game-events.ts
src/store/persist.ts
```

原因是它们承载公共类型、当前状态入口、Runtime 时序和存档兼容。多个 Agent 同时修改会导致接口漂移和难以审查的冲突。

### 推荐第一轮 DAG

```text
T0  Coordinator：冻结 Settlement Contract，并建立基准测试
 |
 +-- T1  Test Agent：Mutation characterization tests（只写新测试文件）
 |
 +-- T2  Kernel Agent：Proposal/WorldEvent/Decision/Evolve 新模块
 |
 +-- T3  Projection Agent：public event projection 原型和测试
 |
 +-- T4  QA Agent：只读检查 T0 Contract 与现有调用链

T1 + T2 + T3 + T4
  → T5 Integration Agent：legacy adapter + GameRuntime 接线
  → T6 QA Agent：原子性、拒绝、replay、post-commit 复验
  → T7 Final Gate
```

依赖说明：

- T0 必须串行且先完成；
- T1/T2/T3 在 Contract 冻结后可并行；
- T5 必须等待前三项集成，不应并行修改 Runtime 热点；
- QA 不修生产代码，只提交缺陷和独立测试；
- Repair 由独立 Agent 根据缺陷执行，再交原 QA 复验。

### 推荐规模

第一轮使用：

- 1 个 Coordinator/Integration Agent；
- 3 个并行 Worker；
- 1 个独立 QA/Gate Agent。

不建议超过 3 个同时写代码的 Worker。当前仓库规模较小，过多 Agent 的协调、接口漂移和 merge 成本会超过收益。

### Owner Files 原则

- 一个文件只能有一个写 Owner；
- Worker 尽量只新增模块或测试文件；
- 公共热点只允许 Integration Agent 修改；
- 每个 Worker 使用独立 worktree 和聚焦 commit；
- Worker 不 push、不 deploy、不 rebase、不 stash、不使用 `git add .`；
- 每个任务必须有独立验证命令和 Handoff；
- 只有集成并通过 Gate 才算完成。

### 并行价值判断

本轮 Settlement 重构满足并行条件：

- 已有研究和目标架构；
- 可以冻结公共 Contract；
- characterization、纯 kernel、projection 和 QA 可隔离；
- 串行完成所有研究、测试、实现和审查耗时明显更长。

但 Phase 3 的 Pi adjudication schema 在业务语义未批准前不应直接并行编码。应先由 Coordinator 给出 Proposal 词汇草案并人工确认，再拆分 parser、decider、projection 和测试。

---

## 8. 每阶段统一质量门

每个集成候选至少执行：

```bash
bun run typecheck
bun test
git diff --check
```

Settlement 相关阶段还必须验证：

- accepted replay determinism；
- rejected proposal leaves state unchanged；
- revision conflict；
- atomic multi-event transaction；
- no public event before commit；
- old-save compatibility；
- NPC/DM/UI are post-commit only。

---

## 9. 当前执行顺序

```text
1. Phase 0：characterization tests + Settlement Contract 批准
2. Phase 1：Settlement Kernel + legacy adapter
3. Phase 2：移动/物品垂直迁移 + committed event projection
4. Phase 3：Pi GM 桌面操作 Proposal
5. Phase 4：缓存候选叙述 + 结构化 rejection/adjustment feedback
6. Phase 5：最小通用 condition 标记
7. Phase 6：Event Journal + snapshot + outbox
8. Phase 7：按真实剧本需求选择增强项
```

---

## 10. 当前任务 DAG

```text
T40 冻结 Settlement Contract
  ├─ T41 补齐 Mutation characterization tests
  ├─ T42 实现 Settlement Kernel 与 evolve
  └─ T43 实现 committed event 公共投影

T41 + T42 + T43
  → T44 集成 legacy adapter 与 GameRuntime
  → T45 独立 QA：原子性、replay、revision、post-commit
  → T46 迁移移动和物品垂直切片
  → T47 实现 Pi GM 桌面操作协议
  → T48 缓存候选叙述并反馈拒绝/修正
  → T49 实现最小通用 condition
  → T50 实现 Event Journal、snapshot 与 outbox
  → T51 最终框架 Gate 与真实游玩验证
```

T40 是当前唯一应立即启动的设计任务。Contract 草案位于 [`docs/settlement-contract.md`](settlement-contract.md)。T41/T42/T43 只有在 Contract 人工批准后才并行派发；T44 和涉及 `GameRuntime` 的修改由 Integration Agent 串行完成。

---

## 11. 通用框架完成定义

满足以下条件后，默认停止扩张通用 Engine，开发重心转向世界包、Prompt 和真实游玩：

- Pi 可以读取完整角色纸、当前房间、可见卡牌、目标、重要事实和已提交事件；
- Pi 可以通过稳定 GM Proposal 移动棋子、调整计数器、发放/消耗卡牌、放置 condition、揭示出口、记录事实和标记目标；
- Engine 能结构化拒绝非法操作，并让同一 Pi Session 在展示前修正；
- 候选叙述不会先于权威提交展示；
- committed events 可以重放 WorldState；
- snapshot、Journal 和 post-commit outbox 可以在崩溃后恢复；
- 重要 NPC 的主观记忆与客观世界状态保持分离；
- `station-dream` 能通过自由调查、一次开放式障碍、任务奖励、关键冲突和多 Outcome 完成完整一局；
- CLI/TUI/Telnet 均只依赖 `GameRuntime` 和公共投影；
- 没有真实剧本需求时，不新增传统 MUD 子系统。

框架完成后，优先投入：

1. 冒险模组开场和线索质量；
2. Pi DM Prompt 与裁定示例；
3. 关键 NPC persona 和独立 Session 表现；
4. 角色卡、道具卡、奖励卡和 condition 卡内容；
5. 真实游玩记录、失败案例和 Prompt/世界包修正；
6. 新世界包，而不是新的自动模拟子系统。
