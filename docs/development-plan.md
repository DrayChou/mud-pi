# mud-pi 开发计划

## 产品目标

用一个小而可靠的规则核心承载 Pi 驱动的持久 DM 与独立 NPC，使每个世界包都能形成“开始—探索—选择—结果—结局”的完整一局，而不是只累积叙事和系统。

本项目定位为 **单人 Pi-first 叙事 RPG**，不建设多人 MUD Server。Pi 是持久主持人、语义裁判和内容导演；Engine 是权威状态守门人，不负责自动运行完整世界生态。详细边界见 `docs/pi-role-boundary.md`。

## 架构原则

权威状态结算的后续底层重构应遵循 `docs/state-settlement-research.md`：将 Agent/玩家输出定义为 Proposal，由纯 Decider 产生 Accepted WorldEvent 或结构化 Rejection，State 只通过 Evolve 已提交 Event 更新，GameEvent、NPC 感知、UI 和 TurnRecord 均作为 post-commit 投影处理。

1. **Pi-first 记忆与裁定**：DM 与重要 NPC 的主观长期记忆使用 Pi 原生 Session；开放交互、陷阱、调查、社交和剧情意义优先由 Pi 判断。
2. **权威状态唯一**：位置、属性、物品、目标和结果以 `WorldState` 为准；Pi 只能提交 Proposal。
3. **代码实现不变量，不穷举玩法**：凡涉及复制、越权、跨回合持续、UI 查询和存档恢复的事实由 Engine 管理；长尾动词和情境合理性交给 Pi。
4. **事实只来自提交事件**：目标架构中 State 只由 committed `WorldEvent` 演化，`GameEvent` 只是公开投影。
5. **按需结构化**：叙事内容只有在后续规则、UI 或恢复需要引用时才提升为结构化权威状态。
6. **确定性作为工具而非教条**：关键冲突、世界脚本和显式骰子可复现；普通开放交互允许 Pi 直接语义裁定。
7. **保持单人范围**：不增加多人并发、PvP、公会、在线 Builder、自动刷怪和离线生态模拟。

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

### P2 — Deterministic Auto Combat

目标：不实现逐回合战斗操作；根据双方数据一次性模拟完整战斗，前端只负责渲染进度条和结果。

工作项（已完成）：

- `attack` 启动一次确定性模拟，直接计算双方最终生命、胜者和风险，不再唤醒 NPC Session 处理逐次攻击。
- 双方按 `speed` 向 100 点行动条累积；行动条满的角色出手，伤害仍由攻击与防御计算。
- 模拟返回每次出手的 tick、行动者、目标、伤害和目标剩余生命，作为纯展示帧；权威状态只在模拟结束后一次性应用。
- 预测失败时输出 `combat_warning`，随后输出结构化 `combat_result`；不会要求玩家管理逐回合技能或反击。
- 玩家死亡/失能继续由 Stats Schema 的 `onDeplete` 确定；NPC 生命耗尽仍产生击败和关键 NPC 死亡事件。
- DM 只叙述模拟结果和代价，不得在结果后追加额外攻击或战斗 Mutation。

### P2 — Deterministic Procedural World

目标：新增确定性程序化地图能力，不破坏已有静态世界。

工作项（混合世界第一阶段已完成）：

- 世界包可通过 `proceduralMap` 在静态剧情地图上扩展确定性房间网络；未声明配置的世界仍保持纯静态。
- 保存 `seed`、`seeded-mst-v1` 生成器版本、语义角色和最终房间/出口快照。
- 使用 seeded PRNG、受方向约束的 Kruskal MST 保证连通，并按树边数量增加约 15% 环路。
- `station-dream` 第一版总房间数为 8–12，程序化节点分配入口、Boss、宝藏、特殊和过渡角色。
- Engine 负责拓扑与语义角色；世界包模板负责名称、描述和世界观换皮，DM 只消费当前房间的权威角色信息。
- CLI 支持 `--seed <value>`；未指定时生成新 seed，读档直接使用保存的最终地图而不重新生成。

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
