# mud-pi

`mud-pi` 是一个开源的、单人 **Pi-first 叙事 RPG 框架**。它把 AI 当作持久的游戏主持人，把代码引擎当作权威数字桌面：

- **Pi DM** 理解玩家的自由表达，裁定调查、交涉、机关、潜行和创造性方案；
- **Engine** 管理位置、实体、物品、参数、状态、目标、骰子和已提交事实；
- **世界包** 定义规则书、冒险模组、角色、道具、结局条件和可信规则脚本；
- **CLI、TUI、Telnet/GMCP、Web** 共用同一个 `GameRuntime`。

项目专注于单人叙事游戏，不是多人共享世界服务器，也不尝试用代码模拟完整世界生态。

## 核心原则

> 代码实现名词和不变量，Pi 解释动词和意义。

玩家不需要猜命令菜单。自然语言行动先被解释为 `ActionIntent`；不明确的引用和开放式行为会交给 Pi 裁定。所有会改变权威状态的结果都必须通过 Engine 提交：

```text
ActionIntent
→ Entity Reference Resolution
→ Pi Adjudication / Deterministic Action
→ Ordered TableOperation
→ Proposal → Decision → WorldEvent → Commit → Evolve
→ NarrativeClaim Verification
→ Final Narration
```

被拒绝的操作不会进入世界事实、NPC 感知、目标进度或玩家界面。详细边界见 [Pi 与 Engine 的职责边界](docs/pi-role-boundary.md)。

## 功能概览

- 持久 Pi DM Session，并复用 Pi 原生 JSONL 和 compaction；
- 重要 NPC 可懒加载独立持久 Pi Session；
- 权威 `WorldState`、revision、事件 Journal、Snapshot 和 Outbox；
- 房间、动态出口、地图探索和确定性程序化地图；
- 权威物品位置、装备、消耗、AI 动态道具和模板约束奖励；
- 世界定义参数、Condition、Objective、StoryOutcome；
- 可复现冲突和骰子结算，支持世界包自定义可信脚本；
- 候选叙述在结算后发布，并校验位置、实体、出口、物品和结局声明；
- CLI、响应式 TUI、Telnet/GMCP 和匿名 Web 试玩入口；
- 结构化 AI 请求、操作、错误和性能诊断日志；
- Pi SDK 与本地 Codex CLI 两种 AI backend。

## 环境要求

### Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

### AI backend

默认使用 [Pi](https://pi.dev)：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi
```

在 Pi 中使用 `/login` 配置 provider，使用 `/model` 查看模型 ID。

也可以使用已经登录的 Codex CLI：

```bash
codex login
codex doctor
```

项目不会要求把 API key 写入仓库。认证由 Pi 或 Codex 自己管理。

## 快速开始

```bash
bun install
cp .env.example .env
bun start
```

新游戏会依次选择世界包和主角。也可以直接指定：

```bash
bun start --world station-dream
bun start --world station-dream --seed night-train-42
bun start --save <存档ID>
```

### 可用界面

```bash
bun start          # 传统逐行 CLI
bun run tui        # 响应式多面板 TUI
bun run telnet     # Telnet/GMCP，默认 127.0.0.1:4000
bun run web        # Web，默认 0.0.0.0:3000
bun run web:dev    # Web 热更新
```

指定参数示例：

```bash
bun start --tui --save <存档ID>
bun start --telnet --host 0.0.0.0 --port 4001
WEB_HOST=127.0.0.1 WEB_PORT=4123 bun run web
```

Web 为每个匿名访客创建隔离的存档、AI Session 和访问 token，不是多人共享世界。公开部署前应配置 HTTPS、限流、日志轮转和运行时回收。

## 配置

复制 `.env.example` 后按需修改：

| 变量 | 说明 | 默认值 |
|---|---|---|
| `AI_BACKEND` | `pi` 或 `codex` | `pi` |
| `DM_BACKEND` | DM 单独使用的 backend | 继承 `AI_BACKEND` |
| `INTERPRETER_BACKEND` | Interpreter backend | 继承 `AI_BACKEND` |
| `CHARACTER_BACKEND` | 角色生成 backend | 继承 `AI_BACKEND` |
| `DM_PROVIDER` / `DM_MODEL` | Pi DM 模型 | 见 `.env.example` |
| `INTERPRETER_PROVIDER` / `INTERPRETER_MODEL` | Pi 指令解析模型 | 见 `.env.example` |
| `CODEX_MODEL` | Codex 默认模型；留空使用本地默认 | — |
| `DM_THINKING` | `off/minimal/low/medium/high` | `low` |
| `AI_INTERPRETER_TIMEOUT_MS` | Interpreter 总超时 | `15000` |
| `AI_DM_TIMEOUT_MS` | DM 总超时 | `30000` |
| `AI_NPC_TIMEOUT_MS` | NPC 总超时 | `30000` |
| `AI_CHARACTER_TIMEOUT_MS` | 角色生成总超时 | `45000` |
| `WORLD_PACK` | 非交互模式默认世界包 | `station-dream` |
| `DEFAULT_PLAYER_NAME` | 默认玩家名 | `旅行者` |

完整示例和注释见 [`.env.example`](.env.example)。

## 玩家输入

精确快捷命令可低延迟执行：

```text
look [目标]   查看环境或实体
north/south/east/west/up/down
say <内容>    与当前场景人物交谈
get <物品>    拾取
inventory     查看背包
equip <物品>  装备
use <物品>    使用
attack <目标> 发起冲突
status        查看角色状态
objectives    查看目标
map           查看已探索地图
help          查看帮助
quit          保存并退出
```

同时支持自然语言和复合行动，例如：

```text
我把车票夹在指间，问售票员这班车是否还能回去。
先观察门缝里的光，再尝试用钥匙轻轻转动锁芯。
返回大厅，找到刚才提到的守卫并向他说明情况。
```

## 存档与诊断

每局游戏保存在：

```text
saves/<存档ID>/
├── state.json
├── turns.jsonl
├── world-events.jsonl
├── agents/
│   ├── manifest.json
│   └── sessions/*.jsonl
└── logs/
    ├── operations.jsonl
    ├── ai-requests.jsonl
    └── errors.jsonl
```

- `state.json` 是当前快照；
- `world-events.jsonl` 是权威提交 Journal；
- `turns.jsonl` 是面向游戏回合的记录；
- `agents/sessions/` 保存 Pi 原生持久 Session；
- `logs/` 保存关联后的请求阶段、耗时、首 token、重试、结算摘要和错误。

诊断命令：

```bash
bun run logs:ai
bun run logs:ai <存档ID>
```

日志可能包含玩家输入和 AI Prompt/Response，但不应包含 API key。`saves/` 和 `.env` 默认被 Git 忽略。

## 世界包

世界包位于 `worlds/<id>/`：

```text
worlds/my-world/
├── world.json
├── lore.md
└── conflict.ts    # 可选，可信本地规则脚本
```

最小启动方式：

```bash
bun start --world my-world
```

世界包可以声明：

- 参数、生命周期阈值和角色模板；
- 房间、出口、NPC、道具和初始位置；
- 预设主角与初始背包；
- Objective、StoryOutcome 和 Condition；
- AI 奖励模板；
- 冲突文案、规则数据和可信脚本；
- 程序化地图配置。

Loader 会在启动时校验 ID 唯一性、引用、位置、参数范围、脚本路径和结局条件。世界包是事实与机械边界，不是要求玩家猜中的固定流程。完整格式和示例见 [世界包开发指南](docs/world-pack-guide.md)。

## 项目结构

```text
src/
├── adapters/       # CLI/TUI/Telnet 输出与协议适配
├── ai/             # backend、Interpreter、DM/NPC Session 与协议解析
├── diagnostics/    # 结构化日志与分析工具
├── engine/         # ActionIntent、规则裁定、冲突、地图和投影
├── runtime/        # 所有界面共享的 GameRuntime
├── store/          # Settlement、Evolve、Journal、Snapshot、Outbox
├── types/          # 权威领域类型
├── web/            # Bun Web 服务与前端
└── main.ts

worlds/             # 公开示例世界包
docs/               # 架构、契约、研究和参考实玩
saves/               # 本地运行数据，不提交
```

## 开发

```bash
bun install
bun run typecheck
bun test
bun run dev
bun run web:dev
```

提交前建议至少执行：

```bash
bun run typecheck
bun test
git diff --check
```

## 文档

从 [文档索引](docs/README.md) 开始阅读：

- [当前架构](docs/design.md)
- [Pi 与 Engine 的职责边界](docs/pi-role-boundary.md)
- [权威结算契约](docs/settlement-contract.md)
- [开发状态与路线图](docs/development-plan.md)
- [世界包开发指南](docs/world-pack-guide.md)
- [发布检查清单](docs/release-checklist.md)
- [参考完整游玩记录](docs/playtests/station-dream-reference-playthrough.md)

## 项目状态

当前版本适合本地开发、架构研究和小范围试玩。它尚未提供大规模公开服务所需的完整运维能力，例如全局限流、AI 请求队列、闲置实例回收、集中监控和 HTTPS 自动化。

## 安全

漏洞报告、存档与日志敏感信息、Web 部署和世界脚本信任边界见 [SECURITY.md](SECURITY.md)。

贡献代码或世界包前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## License

见 [LICENSE](LICENSE)。
