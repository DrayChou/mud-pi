# mud-pi 文档索引

本文档目录分为“当前规范”“开发与使用”“研究背景”和“参考记录”。实现与当前规范冲突时，以代码、测试和 `settlement-contract.md` 为准。

## 建议阅读顺序

1. [`../README.md`](../README.md)：安装、运行、配置和功能概览；
2. [`pi-role-boundary.md`](pi-role-boundary.md)：Pi、Engine 和世界包的职责边界；
3. [`design.md`](design.md)：当前运行链路、状态模型和模块结构；
4. [`settlement-contract.md`](settlement-contract.md)：Proposal、Decision、WorldEvent、Commit、Evolve 契约；
5. [`development-plan.md`](development-plan.md)：当前完成度、剩余技术债和路线图。

## 当前规范

| 文档 | 内容 |
|---|---|
| [`design.md`](design.md) | 当前整体架构、回合流程、持久化和 Adapter 边界 |
| [`pi-role-boundary.md`](pi-role-boundary.md) | “代码实现名词，Pi 解释动词”的产品与技术边界 |
| [`settlement-contract.md`](settlement-contract.md) | 权威结算、原子性、revision、幂等和公共投影契约 |
| [`ai-item-rewards.md`](ai-item-rewards.md) | AI 判断奖励、模板约束和权威生成流程 |
| [`rpgmaker-data-model.md`](rpgmaker-data-model.md) | 参数、装备、traits 和 effects 数据模型 |

## 开发与质量

| 文档 | 内容 |
|---|---|
| [`development-plan.md`](development-plan.md) | 已完成能力、当前限制和后续优先级 |
| [`playtests/station-dream-reference-playthrough.md`](playtests/station-dream-reference-playthrough.md) | 一条可恢复、可重放的参考完整游玩记录 |

项目统一质量门：

```bash
bun run typecheck
bun test
git diff --check
```

## 研究背景

以下文档解释设计来源，不应被当作比当前代码更新的 API 说明：

| 文档 | 内容 |
|---|---|
| [`state-settlement-research.md`](state-settlement-research.md) | Akka Persistence、Equinox、Eventuous、boardgame.io、Wesnoth、Evennia 等方案比较 |
| [`conflict-resolution-research.md`](conflict-resolution-research.md) | 可复现冲突、世界脚本和不同玩法的结算边界 |

## 文档维护约定

- README 只保留用户最常用的安装、运行和概览；
- `design.md` 描述已经存在的架构，不记录设想中的实现；
- `development-plan.md` 区分“已完成”“下一步”和“明确非目标”；
- 研究文档保留方案来源和取舍，不重复维护当前 API；
- 示例不得包含凭证、真实用户数据、本地绝对路径或未公开内容；
- 新增世界包机制时，同时更新 README、设计文档和对应测试。
