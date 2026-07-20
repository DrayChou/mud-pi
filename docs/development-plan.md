# mud-pi 开发计划

## 产品目标

用一个小而可靠的规则核心承载 Pi 驱动的持久 DM 与独立 NPC，使每个世界包都能形成“开始—探索—选择—结果—结局”的完整一局，而不是只累积叙事和系统。

## 架构原则

1. **Pi-first 记忆**：DM 与重要 NPC 的主观长期记忆使用 Pi 原生 Session JSONL 与 compaction。
2. **权威状态唯一**：位置、属性、物品、目标和结局以 `WorldState` 为准。
3. **所有变更走 Mutation**：Agent 只能提出意图；Engine 校验后才能产生 Mutation。
4. **事件由事实派生**：`GameEvent` 从已应用的 Mutation 派生，不允许事件反过来成为第二套状态。
5. **先垂直切片，后扩规模**：先完成 `station-dream`，再增加大型系统和随机地图。
6. **确定性优先**：程序化生成和随机结算必须保存 seed 与生成器版本，并可由测试复现。

## 路线图

### P0 — World Integrity

目标：保证存档中的客观世界状态可信。

工作项：

- 为每件物品保存唯一位置：房间、玩家背包、装备或已销毁。
- 世界包的 `inRoom` / `inInventory` 正确加载为运行时位置。
- `get` 只能拾取当前房间物品。
- `drop` 将物品放入玩家当前房间，并卸下对应装备。
- `equip` 校验物品确实在背包中。
- 房间描述和 DM prompt 只展示当前房间物品。
- 为旧存档补充兼容迁移或规范化逻辑。

验收标准：

- 无法跨房间拾取。
- 丢弃、重新拾取、装备和读档后的物品位置一致。
- 世界加载、命令和 Mutation 测试覆盖上述行为。
- `bun run typecheck`、`bun test`、`git diff --check` 通过。

### P1 — Event Spine

目标：建立规则、叙事、NPC 和目标系统共用的事件主干。

工作项：

- 定义最小 `GameEvent` 判别联合类型。
- 实现 `deriveGameEvents(before, mutations, after)` 纯函数。
- 首批事件覆盖移动、说话、拾取、丢弃、攻击、击败、NPC 移动。
- TurnRecord 保存公开事件；私人 NPC thought 永不写入公开事件。
- 为 NPC 路由提供房间、参与者和可见性信息。

验收标准：

- 同一 before/mutations/after 始终产生相同事件。
- 事件不直接修改状态。
- NPC 只能接收其感知范围内的事件。

### P1 — Objectives & Endings

目标：让世界包拥有可验证的进度与结局。

工作项：

- 定义数据驱动的 Objective 和世界包 StoryOutcome。
- Objective 由 GameEvent/WorldState 确定性更新。
- 增加 `objectives` 或同等查看命令。
- StoryOutcome 配置只存在于世界包，支持 success/failure/death/transformation/abandonment/softlock/custom 与 terminal。
- 每个故事结果的标题、摘要与自然语言 `criteria` 完全由世界包定义；DM 依据当前权威状态、本轮结果和 Pi Session 判断是否满足，并提出 `outcomeReached`。
- Engine 不硬编码任何剧本结束方式；解析层只接受当前世界包声明的 outcome id，存档仅保存已达成的结果快照。
- 为 `station-dream` 制作 4–6 个目标和至少 2 个结局。

建议的 `station-dream` 闭环：

1. 在车站醒来并调查大厅。
2. 与售票员交谈，了解车票规则。
3. 探索站台和车厢，找到关键线索或物品。
4. 处理车厢阴影。
5. 解锁终局地点。
6. 根据事实、物品和选择进入不同结局。

验收标准：

- 一局可在约 20–30 分钟内完成。
- 至少存在一个成功结局和一个失败/代价结局。
- 退出读档后目标状态、结局条件和 Pi Sessions 连续。

### P1 — Map Experience

目标：先让静态小地图可读，再做程序化地图。

工作项：

- 保存房间 `discovered` / `visitedTurn` 状态。
- 玩家移动后确定性标记探索状态。
- 增加 `map` 命令，显示当前位置、已发现房间和已知连接。
- 未发现区域不泄露标题和内容。

验收标准：

- 四个现有世界都能显示可读地图或探索列表。
- 读档后探索状态保持。

### P1 — NPC Event Routing

目标：独立 NPC 不再只在玩家 `say` 时被唤醒。

工作项（已完成第一阶段）：

- 将玩家/Engine 已结算的可见 GameEvent 路由给相关 `pi_session` NPC。
- 支持玩家进入、离开、说话、拾取、丢弃、攻击、击败、死亡/失能，以及其他 NPC 移动等刺激。
- 移动事件可由原房间和目标房间中的 NPC 感知；定向说话只唤醒目标。
- 保留 `requestedAtTurn`、房间和可见实体集合 stale decision 校验。
- 默认每回合最多唤醒两个独立 NPC，优先目标对话、关键死亡和战斗事件。
- DM 在本轮判断前能看到这些 NPC 的公开行动；NPC 私有 `thought` 仍仅保存在其 Pi Session。

验收标准：

- 售票员能对玩家带回车票/线索等客观事件作出持续响应。
- 不在现场的 NPC 不知道未传播的私有事件。

### P2 — Combat Turn Refactor

目标：消除玩家攻击后同步自动反击的双重行动问题。

工作项：

- 玩家攻击只结算玩家行动并产生攻击事件。
- NPC 通过规则脑或 Session 提出 `attack/flee/surrender/wait`。
- Engine 独立校验并结算 NPC 战斗意图。
- 增加玩家死亡/失能结果和可恢复流程。

### P2 — Deterministic Procedural World

目标：新增独立的程序化世界模式，不破坏已有静态世界。

工作项：

- 支持 `static / procedural / hybrid` 世界模式。
- 保存 `seed`、生成器版本和最终地图快照。
- 使用 seeded PRNG、MST 保证连通和少量额外环路。
- 第一版生成 8–12 个房间，分配入口、Boss、宝藏和特殊房间角色。
- Engine 生成拓扑；DM 只做名称、描述和世界观换皮。

验收标准：

- 同 seed 和版本产生相同地图。
- 所有关键房间可达。
- 读档不重新生成地图。

### P2 — Save UX & Smoke Tests

工作项：

- 增加存档版本号和规范化入口。
- 增加轮换备份/快照。
- 验证 `state.json`、agent manifest 与 Session JSONL 引用一致。
- 增加真实 Pi backend 的有界 smoke test。

## 当前执行顺序

```text
1. 提交前保护并审查当前未提交成果
2. P0 物品位置与命令修复
3. P1 GameEvent 主干
4. P1 Objective/Ending + station-dream 垂直切片
5. P1 map/探索状态
6. P1 NPC 事件路由
7. P2 战斗回合重构
8. P2 确定性随机地图
9. P2 存档体验与真实 backend smoke test
```

## 非目标

当前阶段不做：

- 批量创建数百个持久 NPC Session。
- 完整经济、制造、门派、天气和生活技能系统。
- Three.js/WebGL 地图。
- 45 房以上的默认随机地图。
- 与 Pi Session 重复的应用层长期记忆数据库。
