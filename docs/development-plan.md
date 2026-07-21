# mud-pi 开发状态与路线图

## 1. 产品目标

`mud-pi` 是单人 Pi-first 叙事 RPG 框架：Pi 负责自由行动理解、开放情境裁定和叙事连续性；Engine 负责权威实体、状态、不变量、可复现规则、提交和恢复。

长期目标不是自动模拟完整世界，而是提供一套可靠的数字桌面，让世界包和 Pi 可以共同主持可保存、可查询、可重放的单人冒险。

## 2. 已稳定的架构基线

### 2.1 AI 与 Session

- 每个存档绑定一个持久 Pi DM Session；
- 重要 NPC 懒加载独立 Pi Session；
- 直接复用 Pi 原生 JSONL 与 compaction；
- Pi 和 Codex backend 统一抽象；
- Interpreter、DM、NPC、Character 使用独立有界超时；
- Provider 事件、首 token、自动重试和错误可诊断。

### 2.2 Pi-first 编排

- `ActionIntent` 保留原始意图、方法、问题、工具、方向和目的地；
- 实体引用支持 exact、alias、contextual、unregistered、ambiguous、missing；
- 未解决引用和开放式行动在 Engine 直接拒绝前进入 Pi；
- 精确 UI 查询和方向快捷命令保留低延迟路径；
- 通用 intent completion 取代 verb-specific 重试；
- 目的地导航与明确方向分离。

### 2.3 权威桌面

- `Proposal → Decision → WorldEvent → Commit → Evolve`；
- 独立 `revision` 与叙事 `turn`；
- 原子 Settlement、幂等 Proposal 和批次结算；
- 被拒绝的 Proposal 不产生公共事件；
- typed movement、item、parameter、NPC、Objective 和 Outcome 垂直切片；
- legacy mutation 兼容层仍保留，避免 Big Bang。

### 2.4 GM 操作和叙述

- legacy `WORLD_UPDATE` 与 `gmOperations` 标准化；
- 操作按 `materialize → topology → state → outcome` 排序；
- Outcome 在同轮事实和 Objective 后评估；
- 位置、实体、出口、物品、NPC lifecycle 和 Outcome 支持 NarrativeClaim；
- narration correction 最多一次，失败后使用 committed-state fallback。

### 2.5 状态、内容和规则

- 权威房间、出口、探索状态和地图投影；
- 确定性程序化地图；
- 物品唯一位置、装备、消耗和销毁；
- 世界定义参数、traits、effects 和 lifecycle threshold；
- Condition、Objective、StoryOutcome；
- AI 动态物品和模板约束奖励；
- 世界包可信冲突脚本和确定性骰子。

### 2.6 持久化和界面

- WorldEvent Journal、Snapshot 恢复和 checksum；
- 持久 Outbox；
- CLI、TUI、Telnet/GMCP、Web 共用 `GameRuntime`；
- 匿名 Web 实例隔离、恢复 token 和移动端布局；
- operations、AI request 和 error 结构化日志。

## 3. 当前兼容层

以下部分仍保留 legacy 实现，但不阻塞框架使用：

- 未迁移领域仍可经过 `settleLegacyMutation(...)`；
- 部分旧公共事件仍由 legacy `deriveGameEvents(...)` 生成；
- `ParsedCommand` 与 `ActionIntent.legacy` 继续兼容旧命令；
- DM legacy 字段与 `gmOperations` 同时支持。

迁移原则是每完成一个经过测试的领域切片，就删除该领域对应的推断逻辑；不进行一次性全量重写。

## 4. 下一阶段优先级

### P0：最小权威场景对象

目前门、机关、祭坛、家具等多依赖叙事或 `Item.kind="scenery"`。下一步应增加最小 `SceneObject`：

```text
id
name
aliases
roomId
capabilities
state
lifecycle
```

边界：

- 只保存跨回合需要查询或改变的环境名词；
- 支持注册、引用、状态变化和销毁；
- 纳入 Proposal/Event/Evolve/Projection/NarrativeClaim；
- 为旧 scenery item 提供兼容迁移；
- 不建设完整机关模拟器。

### P0：稳定 WorldFact key

为 `WorldFact` 增加可选稳定 key：

```ts
{
  key?: string;
  text: string;
  roomId?: string;
  createdTurn: number;
}
```

目的：

- 让 Outcome、Objective 和世界脚本稳定引用事实；
- 文案可调整而不破坏条件；
- 保持旧存档兼容；
- 不扩展为完整知识图谱。

### P0：真实 Pi 垂直 Gate

至少持续验证三类完整链路：

1. 场景对象 → 新房间 → 新出口 → 玩家移动；
2. 叙事人物 → NPC 注册/别名 → 对话或冲突；
3. 场景对象状态变化 → 稳定 Fact → StoryOutcome。

每个 Gate 必须检查：

- AI 原始响应；
- 标准化 Table Plan；
- Settlement 与 rejection；
- NarrativeClaim；
- TurnRecord、Journal 和 replay 后状态；
- CLI/Web 最终展示。

### P1：导航和引用

- Room aliases；
- 跨多个已知房间的目的地路径建议；
- 多个同名实体的有界澄清；
- 更稳定的复数、代词和场景上下文解析；
- 避免 Pi 已完成动作后再次重放 completion。

### P1：内容创作体验

- 世界包 schema 文档和最小模板；
- 更清晰的 validator 错误路径；
- 世界包预览和静态检查命令；
- 关键对象、事实、目标和 Outcome 的内容 QA；
- Prompt 固定原则、机器协议和当前行动提示分层，避免无限膨胀。

### P1：公开部署基础

在扩大 Web 访问前补充：

- IP/会话限流；
- AI 请求并发队列；
- 闲置 Runtime 回收；
- 日志轮转和磁盘配额；
- 健康检查；
- HTTPS 部署说明；
- 明确的数据保留和删除策略。

### P2：按实际需求评估

只有真实世界包和实玩反复证明需要时再考虑：

- 动态 Objective 激活；
- 轻量世界变量或时钟；
- 多个非互斥 StoryOutcome；
- 通用关系数值；
- 世界包构建/拆分工具；
- 不可信规则脚本的 Worker 或子进程沙箱；
- SQLite 事件存储。

## 5. 明确非目标

当前不计划建设：

- 多人共享世界、PvP、公会或多人权限；
- 自动刷怪、天气、生态、NPC 日程和离线世界演化；
- 完整经济、制作、拍卖和交易系统；
- 以固定 Quest FSM 代替 Pi 主持；
- 让 Engine 穷举开门、潜行、欺骗、烧毁文书等动作；
- 重复建设 DM/NPC 长期记忆数据库；
- 依赖 `Math.random()` 的不可复现权威结算；
- exactly-once AI invocation；
- 未经人工批准的自动生产发布。

## 6. 质量门

每次通用框架变更至少执行：

```bash
bun run typecheck
bun test
git diff --check
```

涉及 Settlement、Journal、Outbox 或恢复时，还必须覆盖：

- accepted/rejected/adjusted；
- stale revision；
- 原子失败不修改 live state；
- Proposal 幂等重试；
- Journal replay；
- Snapshot 损坏恢复；
- Outbox 丢失写入恢复；
- 被拒绝操作不进入公共投影。

涉及 Pi 编排时，还必须检查：

- 原始玩家输入是否完整传给 DM；
- unresolved reference 是否有机会进入 Pi；
- TableOperation 依赖顺序；
- completion 是否重复执行；
- NarrativeClaim 是否覆盖叙述中的权威变化；
- correction/fallback 是否与 committed state 一致；
- Provider 超时是否有界且可诊断。

## 7. 变更准则

引入通用机制前回答：

1. 这是跨回合、可查询或会破坏一致性的状态吗？
2. 至少两个不同世界包会合理使用它吗？
3. 它是在表达名词和不变量，还是在穷举玩家动词？
4. Pi 能否通过现有 Proposal 词汇裁定，而不增加新系统？
5. 真实实玩是否已经暴露缺口？
6. 能否以兼容垂直切片实现，而不是重写整个 Runtime？

如果多数答案是否定的，优先把内容留在叙述或世界包中。
