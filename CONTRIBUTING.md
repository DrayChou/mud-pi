# Contributing to mud-pi

感谢你考虑为 `mud-pi` 贡献代码、世界包、测试或文档。

`mud-pi` 的核心目标是提供一个单人 Pi-first 叙事 RPG 框架：AI 负责开放语义和叙事裁定，Engine 负责权威实体、不变量、提交、恢复和可查询状态。

## 开始之前

请先阅读：

1. [`README.md`](README.md)
2. [`docs/pi-role-boundary.md`](docs/pi-role-boundary.md)
3. [`docs/design.md`](docs/design.md)
4. [`docs/settlement-contract.md`](docs/settlement-contract.md)
5. [`docs/world-pack-guide.md`](docs/world-pack-guide.md)

涉及安全问题时不要提交公开 Issue，见 [`SECURITY.md`](SECURITY.md)。

## 开发环境

项目使用 Bun：

```bash
git clone https://github.com/DrayChou/mud-pi.git
cd mud-pi
bun install --frozen-lockfile
cp .env.example .env
```

运行质量门：

```bash
bun run typecheck
bun test
git diff --check
```

启动方式：

```bash
bun start
bun run tui
bun run telnet
bun run web
```

真实 AI 调用需要在本机配置 Pi 或 Codex；绝大多数测试不需要认证或付费 Provider。

## 提交什么类型的修改

欢迎：

- 可复现的 Bug 修复；
- Settlement、Journal、Outbox 和恢复不变量测试；
- Pi-first 意图、实体引用和叙述一致性改进；
- 通用世界包能力；
- 公开原创世界包；
- CLI、TUI、Telnet/GMCP 和 Web 的可用性改进；
- 安全、隐私、性能和诊断改进；
- 文档、示例和测试修正。

大型功能建议先开 Issue 说明问题、用例、边界和迁移方式，避免实现方向与项目范围冲突。

## 通用 Engine 与世界包边界

提交新机制前请确认：

1. 这是跨回合、可查询或会破坏一致性的状态吗？
2. 至少两个不同世界包会合理使用它吗？
3. 它表达的是名词和不变量，还是在穷举玩家动词？
4. Pi 能否通过现有 Proposal/TableOperation 完成裁定？
5. 是否有真实复现或实玩证据？
6. 能否作为兼容垂直切片实现？

特定角色、地点、剧情流程、密码、技能和世界观术语应留在世界包，不应写入通用 `src/`。

不要为以下动作分别增加专用命令，除非存在明确、通用、权威的不变量：

```text
开门
翻窗
说服
欺骗
潜行
烧毁文书
检查机关
向 NPC 坦白
```

这些通常应由 Pi 理解，再通过有限的桌面操作提交结果。

## 代码约定

- 使用 TypeScript 和 ESM；
- 默认使用 Bun API；
- 保持单人范围；
- 权威随机不得使用 `Math.random()`；
- State 只能由 committed `WorldEvent` 通过 `evolve()` 修改；
- 被拒绝的 Proposal 不能产生公共 GameEvent；
- Adapter 不得绕过 `GameRuntime` 修改状态；
- AI 输出视为不可信 Proposal；
- 不要用语言特定 fast path 掩盖 Provider 或协议错误；
- 避免无关重构和大规模格式化。

## 测试要求

### 普通修改

至少运行：

```bash
bun run typecheck
bun test
git diff --check
```

### Settlement 和状态修改

测试应覆盖：

- accepted 和 rejected；
- stale revision；
- 原子失败不修改 live state；
- Proposal 幂等重试；
- exact WorldEvent replay；
- 被拒绝操作不进入公共投影；
- 旧存档兼容。

### Journal、Snapshot 和 Outbox

测试应覆盖：

- Journal replay；
- 损坏 snapshot 恢复；
- checksum/revision 分叉拒绝；
- staged outbox 恢复；
- 副作用失败不回滚事实。

### Pi 编排

测试应覆盖：

- 原始玩家表达保留；
- unresolved reference 可以进入 Pi；
- TableOperation 依赖顺序；
- completion 不重复执行；
- NarrativeClaim 与 committed state 一致；
- correction 和 fallback 有界；
- 测试不调用真实付费 Provider。

### 世界包

遵循 [`docs/world-pack-guide.md`](docs/world-pack-guide.md)，并确保：

- Loader/Validator 可以加载；
- ID 与引用有效；
- 关键 Item/NPC/Objective/Outcome 有测试；
- 冲突脚本使用确定性 seed；
- lore 不要求玩家猜固定命令；
- 内容为原创或具有明确兼容许可证。

## Pull Request 建议

一个 PR 尽量只解决一个主题，并包含：

- 问题与用户影响；
- 方案和边界；
- 修改的主要文件；
- 测试命令与结果；
- 存档兼容影响；
- 新增世界包字段或迁移方式；
- UI 修改的截图（如适用）。

建议提交信息使用简短英文前缀：

```text
feat: add ...
fix: prevent ...
docs: explain ...
test: cover ...
refactor: simplify ...
```

## 隐私与仓库卫生

不要提交：

```text
.env
saves/
Pi Session JSONL
AI 请求日志
Web bearer token
API key
OAuth token
cookie
私钥
node_modules/
本地绝对路径
真实用户数据
```

上传日志前必须脱敏。不要把完整存档作为普通 Bug 附件。

## 兼容性

- 保持现有公开世界包可加载；
- 新字段优先可选，并为旧存档提供默认值；
- 删除 legacy 路径前先完成对应 typed vertical slice；
- 不进行一次性 Big Bang 数据迁移；
- 文档、类型、Validator 和测试应同步更新。

## License

提交贡献即表示你有权提供该内容，并同意贡献按仓库的 [`LICENSE`](LICENSE) 发布。不要提交来源不明、未经授权或许可证不兼容的代码、文本和素材。
