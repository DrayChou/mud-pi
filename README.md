# mud-pi

AI 驱动的文字 MUD 引擎。世界观只提供开场设定，地图、剧情、NPC 由 DM（Pi 或 Codex AI backend）在游戏中动态生成。

## 项目地址

- GitHub: <https://github.com/DrayChou/mud-pi>

## 前置条件

使用本项目之前，用户需要先安装并配置好至少一个 AI backend：默认推荐 [Pi](https://pi.dev)；如果客户只有 Codex，也可以使用本地 Codex CLI。本项目不会提交、保存或要求你把密钥写进仓库；只读取用户本机已经登录/配置好的 AI 能力。

### 1. 安装 Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

也可以参考 Bun 官方文档：<https://bun.sh/docs/installation>

### 2. 安装 Pi（官方方式）

Pi 官方 README 当前推荐的 npm 安装方式：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

官方安装脚本方式：

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

更多说明见 Pi 官网和官方文档：

- <https://pi.dev>
- <https://www.npmjs.com/package/@earendil-works/pi-coding-agent>

### 3. 配置 AI backend

#### 方式 A：Pi（默认）

先打开 Pi 并完成登录或 API key 配置：

```bash
pi
```

在 Pi 里可以使用：

```text
/login   # 选择 provider 并登录
/model   # 查看或切换模型
```

也可以通过环境变量/API key 使用 Pi 支持的 provider。模型列表和自定义 provider 配置请参考 Pi 官方文档中的 Providers & Models / Custom Models。

#### 方式 B：Codex CLI

如果客户本地只有 Codex，先确认已安装并登录 Codex：

```bash
codex login
codex doctor
```

然后在 `.env` 中设置：

```env
AI_BACKEND=codex
# 可选：不填则使用 Codex 默认模型
# CODEX_MODEL=gpt-5.1
```

## 快速开始

```bash
# 1. 安装依赖
bun install

# 2. 复制配置模板
cp .env.example .env

# 3. 编辑 .env：选择 AI_BACKEND=pi 或 codex，并配置模型名称
#    大模型负责 DM 叙事与世界推进；小模型负责玩家指令解析。

# 4. 启动
# 新游戏会先选择剧本，再创建角色
bun start
```

开发模式：

```bash
bun run dev
```

启动选项：

```bash
bun start --world station-dream   # 指定世界包
bun start --save station-dream-001 # 读取存档
bun start --name 旅行者            # 兼容旧用法：预填玩家姓名
bun start --world station-dream --seed night-train-42 # 复现程序化地图
bun run tui                         # 使用本地多面板 TUI
bun start --tui --save <存档ID>     # 用 TUI 读取指定存档
bun run telnet                      # 在 127.0.0.1:4000 启动 Telnet/GMCP
bun start --telnet --host 0.0.0.0 --port 4001 --save <存档ID>
```

TUI 在宽终端中显示玩家/目标、叙事、房间/地图三个面板；窄终端自动切换为纵向布局。按 Enter 发送指令，Esc 或 Ctrl+C 保存并退出。传统逐行 CLI 仍是默认 adapter。

Telnet adapter 第一版默认只监听本机并允许一个控制客户端连接；如需远程连接可显式传入 `--host 0.0.0.0`，并自行配置防火墙。支持 ANSI 文本及 GMCP：`Char.Vitals`、`Room.Info`、`MudPi.Inventory`、`MudPi.Objectives`、`MudPi.Map`、`MudPi.Combat`、`MudPi.Outcome`。可使用 Mudlet、TinTin++ 或普通 telnet 客户端连接；服务端按 Ctrl+C 保存并停止。

新游戏启动后会先进入剧本选择流程；选择剧本后再进入角色创建流程：选择故事包预设主角，或输入自己的姓名和角色描述，由 AI 根据世界观生成候选主角后再选择。玩家姓名限制为 1-16 个字符；背景、作品参考和人物描述请写到“角色描述”里。非交互环境会自动使用 `.env` 中的 `WORLD_PACK`。

## 配置说明（.env）

本项目支持 Pi SDK 和 Codex CLI 两种 backend。请先在对应工具中完成登录/模型配置，然后在 `.env` 中选择 backend 和模型名。

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `AI_BACKEND` | 默认 AI backend：`pi` 或 `codex` | `pi` |
| `DM_BACKEND` | 可选：DM 单独使用的 backend | 继承 `AI_BACKEND` |
| `INTERPRETER_BACKEND` | 可选：指令解析单独使用的 backend | 继承 `AI_BACKEND` |
| `CHARACTER_BACKEND` | 可选：角色生成单独使用的 backend | 继承 `AI_BACKEND` |
| `DM_PROVIDER` | Pi backend 下 DM 大模型 provider | `openai-proxy` |
| `DM_MODEL` | Pi backend 下 DM 大模型名称 | `claude-sonnet-4.6` |
| `INTERPRETER_PROVIDER` | Pi backend 下指令解析小模型 provider | `openai-proxy` |
| `INTERPRETER_MODEL` | Pi backend 下指令解析小模型名称 | `gpt-5.4-mini` |
| `CODEX_MODEL` | Codex backend 默认模型；留空使用 Codex 自己的默认模型 | — |
| `CODEX_DM_MODEL` | 可选：Codex backend 下 DM 模型 | 继承 `CODEX_MODEL` |
| `CODEX_INTERPRETER_MODEL` | 可选：Codex backend 下指令解析模型 | 继承 `CODEX_MODEL` |
| `CODEX_CHARACTER_MODEL` | 可选：Codex backend 下角色生成模型 | 继承 `CODEX_MODEL` |
| `DM_THINKING` | DM 思考深度：off/minimal/low/medium/high | `low` |
| `WORLD_PACK` | 默认世界包；非交互启动或直接回车时使用 | `station-dream` |
| `DEFAULT_PLAYER_NAME` | 默认玩家名 | `旅行者` |

Pi 用户可先运行 `pi`，再用 `/model` 查看可用 provider/model id。Codex 用户可运行 `codex doctor` 检查本机登录和运行状态。`.env` 应保留在本地，不要提交。

## 隐私与安全

- `.env`、本地存档 `saves/`、`node_modules/` 等已在 `.gitignore` 中排除。
- 不要把 API key、OAuth token、cookie、私钥或本地 Pi 登录态提交到仓库。
- Pi / Codex 的认证信息保存在用户本机对应工具的配置目录中，本项目不会把认证信息写入项目文件。
- 游戏存档可能包含玩家输入、生成剧情和测试内容，默认不提交。

## 游戏指令

```text
look [目标]   查看周围或物品
go <方向>     移动（东/西/南/北）
say <内容>    说话（DM 会让 NPC 响应）
get <物品>    拾取
drop <物品>   丢弃
equip <物品>  装备
attack <目标> 调用当前世界包的冲突脚本
use <物品>    调用世界脚本解释道具 effects
inv           查看背包
status        查看状态
help          显示帮助
quit          保存并退出
```

## 存档

每局游戏自动保存在本地 `saves/{worldId}/`：

- `state.json` — 当前世界快照
- `turns.jsonl` — 完整轮次日志（追加写入，不修改）
- `agents/manifest.json` — DM/NPC 与 Pi Session 的引用关系
- `agents/sessions/*.jsonl` — Pi 原生持久会话文件，包含历史与 compaction 记录

Pi backend 下，DM 会话与存档绑定；退出后使用 `--save` 载入时会精确恢复同一个 Pi Session，而不是重新创建开场。世界包中标记为 `controller: "pi_session"` 的重要 NPC 也会在玩家首次与其对话时懒创建独立 Pi Session，并在后续读档中恢复自己的 JSONL 历史。旧存档或会话文件缺失时，会根据权威状态创建恢复会话。Codex backend 仍使用 ephemeral one-shot 调用。

`saves/` 是本地运行数据，默认不提交。复制存档时请复制整个 `saves/{worldId}/` 目录，以保留 Pi 长期会话。

## 添加世界包

在 `worlds/` 下新建目录：

```text
worlds/my-world/
├── world.json   # 初始房间、NPC、物品
└── lore.md      # 世界观（注入给 DM）
```

然后启动：

```bash
bun start --world my-world
```

## 项目结构

```text
src/
├── types/
│   ├── world.ts        # WorldState 数据结构
│   └── mutations.ts    # EngineMutation + DmMutation（所有变更类型）
├── store/
│   ├── apply.ts        # applyMutation() — 唯一变更入口
│   └── persist.ts      # state.json + turns.jsonl 读写
├── engine/
│   ├── commands.ts     # 指令 → EngineMutation[]
│   └── world-loader.ts # 世界包加载
├── ai/
│   ├── backend.ts             # AI backend 抽象
│   ├── pi-backend.ts          # Pi SDK backend
│   ├── codex-backend.ts       # Codex CLI backend
│   ├── character-generator.ts # 用户描述 → 主角候选
│   ├── interpreter.ts         # 小模型：文本 → ParsedCommand
│   ├── dm-session.ts          # DM 会话封装
│   ├── dm-prompt.ts           # 构建每轮 DM prompt
│   └── dm-parser.ts           # DM 返回 → DmMutation[]
└── main.ts             # CLI 入口
```

## 角色创建

每个世界包可以在 `world.json` 中提供 `defaultProtagonistId` 和 `protagonists[]`。新游戏启动后，玩家会在 CLI 中选择预设主角，或输入自己的姓名和角色描述，让 AI 生成符合世界观的候选角色。姓名只接受短名称；AI 生成角色会被要求创作原创角色，不复刻已有小说、影视、游戏、动漫或其他作品中的角色。

角色信息会保存到 `state.player.profile` 快照中，并注入每轮 DM prompt，使叙事能稳定参考角色背景、动机、初始物品和开场钩子。存档保存的是创建时的角色快照，因此故事包后续更新不会改变旧存档。

世界包加载时会校验引用关系和属性范围：出生点、出口、NPC 房间、物品位置、默认主角、初始物品、属性 key 都必须有效。若某个 NPC 或主角需要超过 schema 默认上限，可以显式提供 `hpMax`、`mpMax` 这类 `{stat}Max` override。

重要 NPC 可以拥有独立长期 Pi Session：

```json
{
  "id": "ticket_clerk",
  "name": "售票员",
  "roomId": "StationHall",
  "personality": "神秘、惜字如金",
  "controller": "pi_session",
  "persona": {
    "background": "你在没有日期的售票窗口后工作了很久。",
    "speechStyle": "句子简短，常用车票和归途作隐喻。",
    "goals": ["判断旅客是否准备好面对目的地"],
    "constraints": ["不直接说出玩家内心的答案"]
  }
}
```

这类 Session 只在 NPC 首次需要回应时创建。NPC 负责自己的私人记忆，并可提出 `say`、`move` 或 `wait` 意图；Engine 会验证回合、位置、房间人员和出口后再产生 Mutation，DM 只叙述已经确定的公开结果。

世界包主角示例：

```json
{
  "defaultProtagonistId": "lost_commuter",
  "protagonists": [
    {
      "id": "lost_commuter",
      "name": "迟归的通勤者",
      "summary": "每天搭乘末班车的人，却忘了自己要回哪里。",
      "background": "你总觉得自己错过了一站，但车票上没有目的地。",
      "motivation": "找回自己真正想回去的地方。",
      "initialStats": { "hp": 100, "attack": 6, "defense": 3 },
      "initialInventory": ["ticket"],
      "openingHook": "你在空白时刻表前醒来，手里攥着一张没有目的地的旧车票。"
    }
  ]
}
```

## Codex 兼容说明

当 `AI_BACKEND=codex` 时，mud-pi 会通过本地 `codex exec` 调用 Codex，并使用：

```bash
codex exec --ephemeral --ignore-rules --sandbox read-only --ask-for-approval never
```

这样 Codex 只作为只读 AI 生成 backend 使用，不会让 Codex 修改项目文件。DM、指令解析、角色生成都可以统一走 Codex；也可以用 `DM_BACKEND` / `INTERPRETER_BACKEND` / `CHARACTER_BACKEND` 混用 Pi 和 Codex。

## 剧本化冲突规则

每个世界包通过 `conflictScript: "./conflict.ts"` 指定自己的冲突计算脚本，`conflictRules` 只作为脚本数据；未声明脚本时使用本地默认 resolver。风险提示文案由世界包定义，避免显示“数据模拟”等出戏术语。冲突调研见 [`docs/conflict-resolution-research.md`](docs/conflict-resolution-research.md)。参数、装备、traits 和道具 effects 的 RPG Maker 式数据分层见 [`docs/rpgmaker-data-model.md`](docs/rpgmaker-data-model.md)。

## 开发命令

```bash
bun install       # 安装依赖
bun run dev       # watch 模式启动
bun start         # 启动传统 CLI
bun run tui       # 启动多面板 TUI
bun run telnet    # 启动 Telnet/GMCP 服务（默认端口 4000）
bun test          # 运行测试
bun run typecheck # TypeScript 类型检查
```
