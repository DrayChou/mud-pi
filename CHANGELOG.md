# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)。

## [Unreleased]

### Added

- 公开世界包开发指南与安全报告说明。
- 开源贡献指南和发布检查清单。

## [0.1.0] - 2026-07-21

首个公开 Alpha 基线。

### Added

- 单人 Pi-first 叙事 RPG Runtime；
- Pi SDK 与本地 Codex CLI backend；
- 持久 DM Session 和重要 NPC 独立持久 Session；
- `ActionIntent` 与实体引用解析；
- 自然语言、复合行动和目的地式导航；
- 权威 `WorldState`、turn 和 revision；
- `Proposal → Decision → WorldEvent → Commit → Evolve` Settlement Kernel；
- typed movement、item、parameter、NPC、Objective 和 Outcome 结算切片；
- legacy mutation 兼容层；
- Canonical TableOperation 与依赖阶段排序；
- NarrativeClaim 校验、有界修正和权威状态 fallback；
- WorldEvent Journal、Snapshot 恢复、幂等 Proposal 和持久 Outbox；
- 世界定义参数、生命周期 threshold、Condition、traits 和 effects；
- 权威物品位置、装备、消耗、销毁和动态道具；
- AI 判断、模板约束的 NPC/任务奖励；
- Objective、StoryOutcome 和关键 NPC 死亡评估；
- 可复现自动冲突、骰子和世界包可信规则脚本；
- 静态与确定性程序化地图；
- 预设主角和 AI 辅助原创角色创建；
- CLI、响应式 TUI、Telnet/GMCP 和匿名 Web Adapter；
- Web 隔离存档、恢复 token 和端口自动选择；
- 结构化 operations、AI request 和 error 诊断日志；
- `cthulhu`、`dnd`、`elysium`、`station-dream` 示例世界包；
- Settlement、Journal、Outbox、AI 协议、地图、冲突、世界包和 Adapter 测试。

### Known limitations

- 项目处于 Alpha 阶段，世界包 schema 仍可能兼容演进；
- 不是多人共享世界服务器；
- Web Adapter 尚未内置大规模公开部署所需的全局限流、AI 队列、实例回收和 HTTPS；
- 世界包 TypeScript 规则脚本仅适合可信本地代码；
- 部分未迁移领域仍保留 legacy mutation/event 推断路径；
- 场景对象目前主要通过叙述与 scenery item 表达；
- StoryOutcome 当前是单一已到达结果，而不是多个并行结果集合；
- 不保证 exactly-once AI invocation；提交后的权威事实通过幂等 Settlement 和恢复机制保护。

[Unreleased]: https://github.com/DrayChou/mud-pi/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/DrayChou/mud-pi/releases/tag/v0.1.0
