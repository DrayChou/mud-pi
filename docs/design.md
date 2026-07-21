# mud-pi 当前架构

## 1. 产品模型

`mud-pi` 是单人 Pi-first 叙事 RPG 框架。它采用数字桌游而不是完整世界模拟器的心智模型：

- Pi DM 是持久主持人、语义裁判和内容导演；
- 重要 NPC 可以拥有独立持久 Pi Session；
- 世界包是规则书、冒险模组、角色卡、道具模板和可信规则脚本；
- Engine 是权威数字桌面、角色纸、棋子、计数器、骰塔和战役记录本；
- Adapter 只负责输入输出，不拥有游戏规则。

核心原则：

> 代码实现名词和不变量，Pi 解释动词和意义。

详细产品边界见 [`pi-role-boundary.md`](pi-role-boundary.md)。

## 2. 回合主链路

```text
玩家自然语言
→ Interpreter
→ ActionIntent
→ Entity Reference Resolution
→ 确定性动作或 Pi AdjudicationPlan
→ CanonicalTableOperation[]
→ ProposalBatch
→ Decision
→ WorldEvent
→ Commit
→ Evolve
→ Public Projection / Outbox
→ NarrativeClaim Verification
→ 最终叙述
```

### 2.1 ActionIntent

Interpreter 提取玩家表达的主要意图、目标、方法、问题、工具、方向和目的地。`ActionIntent` 保留原始文本和 legacy command，允许逐步迁移而不进行 Big Bang 重写。

实体引用解析结果包括：

```text
exact
alias
contextual
narrated_unregistered
ambiguous
missing
```

`missing` 不自动等于“目标不存在”。未注册的叙事实体、含糊称呼和开放式行为必须有机会进入 Pi。

### 2.2 确定性动作与 Pi 裁定

以下行为适合 Engine 直接处理：

- 精确方向快捷命令；
- 背包、状态、地图等 UI 查询；
- 已解析实体的普通拾取、装备和使用；
- 世界包已声明的确定性冲突或骰子；
- 生命周期和终局后的权威限制。

以下行为优先进入 Pi：

- 调查、欺骗、说服、潜行和机关；
- 目的地式导航和未注册场景引用；
- 不完整、含糊或复合行动；
- 创造性方案与成功程度；
- 剧情意义、代价和非机械后果。

Pi 只能提出操作，不能直接修改状态。

## 3. 权威结算

状态修改遵循：

```text
Proposal → Decision → WorldEvent → Commit → Evolve
```

### 3.1 Proposal

Proposal 表示某个来源希望桌面发生的操作。来源包括：

```text
player
engine
dm
npc
objective
world_script
system
```

不同来源有不同权限。DM 不能绕过 Engine 修改独立控制 NPC，世界脚本也不能获得无限 GM 权限。

### 3.2 Decision

Decider 是纯裁定边界：

```text
state + proposal → accepted/rejected/adjusted + exact events
```

拒绝必须结构化，不能依赖 `console.warn` 表达业务结果。

### 3.3 WorldEvent 与 Evolve

WorldEvent 保存可以确定性重放的精确事实，而不是模糊命令。例如参数变化事件保存 before/after，物品转移保存精确来源和目的地。

`evolve(state, event)` 是权威状态演化入口。提交失败时 live state 和 revision 不变。

### 3.4 Revision 与 Turn

- `turn` 是叙事时间；
- `revision` 是权威状态版本。

一轮可以提交多个事务，因此两者不能混用。异步 NPC 和 AI 响应应使用 revision、房间和可见实体快照做 stale 校验。

完整契约见 [`settlement-contract.md`](settlement-contract.md)。

## 4. Pi 桌面操作协议

DM 的 legacy `WORLD_UPDATE` 与新的 `gmOperations` 会被标准化为 `CanonicalTableOperation`，并按依赖阶段排序：

```text
materialize → topology → state → outcome
```

含义：

1. 先创建房间、NPC 和物品；
2. 再建立出口和拓扑；
3. 再移动实体、转移卡牌、调整参数、记录事实；
4. 最后完成 Objective 或 StoryOutcome。

这样可以在同一轮安全支持：

```text
创建房间 → 建立出口 → 移动玩家
创建 NPC → 发起交互
创建物品 → 转入背包
记录事实 → 评估结局
```

## 5. 叙述一致性

DM 首次返回的是候选叙述。只有在操作完成结算后，Runtime 才会发布最终文本。

可声明并验证的 `NarrativeClaim` 包括：

```text
player_location
entity_present
exit_available
item_location
npc_lifecycle
outcome
```

若候选叙述与 committed state 不一致，Runtime 会在同一 Session 中进行最多一次有界修正。修正失败或超时时使用 committed-state fallback，不回滚已经成立的事实。

## 6. 双层状态与记忆

### 6.1 WorldState

`WorldState` 保存客观权威状态：

- 玩家位置、参数、生命周期和角色快照；
- 房间、出口、探索状态和地图元数据；
- NPC、物品位置、装备和销毁状态；
- Condition、Objective、StoryOutcome；
- WorldFact 和 PlotThread；
- turn、revision 和确定性随机种子。

### 6.2 Pi Session

Pi Session 保存主观连续性：

- 对话语气；
- 叙事风格；
- 角色印象；
- 私人记忆；
- 压缩后的长上下文。

项目直接复用 Pi 原生 JSONL 和 compaction，不另建重复的长期记忆数据库。客观事实必须回到 `WorldState`，不能只依赖 Session 记忆。

## 7. 持久 NPC

世界包可将重要 NPC 声明为：

```json
{
  "controller": "pi_session",
  "persona": {
    "background": "...",
    "speechStyle": "...",
    "goals": ["..."],
    "constraints": ["..."]
  }
}
```

Session 只在 NPC 第一次需要回应时创建。NPC 可以提出有界的：

```text
say
move
wait
give_item
```

Engine 验证 NPC 是否存活、是否同房间、出口是否存在、奖励模板是否允许以及响应是否过期。NPC 私有 thought 不进入公开 TurnRecord，也不会发送给其他 NPC。

## 8. 世界包

世界包目录：

```text
worlds/<id>/
├── world.json
├── lore.md
└── conflict.ts   # 可选
```

`world.json` 可以定义：

- 世界摘要和出生点；
- 参数 schema、生命周期 threshold；
- 房间、出口、NPC 和道具；
- 预设主角与初始背包；
- Condition；
- Objective 及依赖；
- StoryOutcome criteria；
- AI 奖励模板；
- 冲突规则和程序化地图配置。

`lore.md` 提供主题、事实、语气和边界，不应写成要求玩家猜中的命令列表。

可信 `conflict.ts` 在世界包目录内执行，并必须返回受验证的结构化数值。第三方不可信脚本目前不具备完整进程级沙箱，不应直接加载。

## 9. 持久化

```text
saves/<id>/
├── state.json
├── turns.jsonl
├── world-events.jsonl
├── outbox.jsonl
├── agents/
│   ├── manifest.json
│   └── sessions/*.jsonl
└── logs/
```

### Journal

`world-events.jsonl` 保存 committed transactions。Snapshot 可以通过 Journal 恢复，并使用 checksum 和 revision 防止读取错误分叉。

### Outbox

需要在提交后执行的持久化和投影副作用进入 Outbox。失败副作用可以重试，但不能回滚已经提交的世界事实。

### TurnRecord

`turns.jsonl` 是叙事回合记录，不是唯一权威来源。被拒绝的 Proposal 不应伪装成已经执行的 TurnRecord 内容。

## 10. Runtime 与 Adapter

`GameRuntime` 是所有界面的共同应用层：

```text
CLI ─┐
TUI ─┼→ GameRuntime → Engine / AI / Store
Telnet┤
Web ─┘
```

Adapter 可以展示不同 UI，但不能绕过 Runtime 修改状态。

- CLI：传统逐行文本；
- TUI：宽屏三面板、窄屏纵向布局；
- Telnet：ANSI 与 GMCP 投影；
- Web：匿名隔离实例和恢复 token。

## 11. AI backend 与超时

所有 AI 角色通过统一 backend 抽象调用：

- Pi backend 使用模型注册、认证和持久 Session；
- Codex backend 使用只读、ephemeral 的本地 CLI 调用。

Interpreter、DM、NPC 和 Character 使用独立有界超时。Provider 失败必须显式记录，不能用硬编码语言 fast path 掩盖。DM 超时使用权威状态 fallback，不回滚 committed events。

## 12. 诊断

每个请求使用 world、request、turn、revision 和 AI call ID 关联：

```text
operations.jsonl
ai-requests.jsonl
errors.jsonl
```

关键阶段包括：

```text
interpreter
pi_session_stage
pi_request_policy
pi_first_event
pi_first_text_delta
pi_assistant_message_end
dm_table_plan
settlement
narration_correction
```

日志用于分析首 token、总耗时、Provider 重试、错误率和状态结算，不记录 API key。

## 13. 代码结构

```text
src/
├── adapters/       # CLI/TUI/Telnet 协议和展示
├── ai/             # backend、Prompt、Parser、Session
├── content/        # 通用展示文案
├── diagnostics/    # 日志和分析
├── engine/         # 意图、规则、地图、冲突、投影
├── runtime/        # GameRuntime 和输出模型
├── store/          # Settlement、Journal、Evolve、Outbox
├── types/          # 领域类型
├── web/            # Bun Web 服务和前端
└── main.ts
```

## 14. 明确非目标

当前不建设：

- 多人共享世界、PvP、公会和权限体系；
- 自动生态、NPC 日程、天气和离线世界模拟；
- 完整 Quest FSM 或要求玩家按固定流程行动；
- 完整经济、制作和交易所；
- 由 Engine 穷举所有自然语言动作；
- exactly-once AI invocation；
- 面向不可信第三方脚本的完整沙箱。
