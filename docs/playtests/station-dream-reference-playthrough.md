# station-dream 参考完整游玩记录

## 当前 HEAD 干净验收

在修复开发期 playthrough 暴露的问题后，使用全新存档 `station-dream-1784619354954`，在同一代码版本上从头执行，并在回声检票廊后正常退出、重启和继续，没有修改代码或存档。

最终权威状态：

```text
turn: 11
revision: 47
room: Compartment3
outcome: return_with_ticket
journal transactions: 47
turn records: 11
turn sequence: 1..11（连续且无重复）
```

全部 Objective 完成。`echo_mark` 在回声检票廊被 Pi 合理施加，并在进入最后车厢的回合边界产生 committed `condition_expired`；最终实例为空。隐藏出口通过 committed `set_exit` 揭示，保存恢复后仍存在。冲突后生命为 89，Pi 在同一响应提交 `return_with_ticket`，没有再次出现“只叙述终局、不提交 Outcome”的问题。

本节是当前代码版本的干净成功路径验收证据。下方早期记录保留为开发期修复过程。

## 开发期修复型范围

使用真实持久 Pi DM/NPC Session，经 CLI 完成一局 `station-dream`：

```text
开场
→ 调查大厅
→ 与售票员交谈
→ 进入站台和列车
→ 拾取并装备锈铁刀
→ 进入回声检票廊
→ 用自由叙述坦白归途
→ 揭示隐藏出口
→ 保存并重启恢复
→ 进入最后车厢
→ 结构化冲突
→ 完成全部 Objective
→ 达成 return_with_ticket
```

开发期测试存档：`station-dream-1784616443748`。该存档跨越多个修复提交，只用于记录问题发现过程，不是最终干净验收夹具。

## 最终权威状态

```text
turn: 13
revision: 61
room: Compartment3
outcome: return_with_ticket
journal transactions: 61
turn records: 14
```

已完成目标：

- `ask_ticket_clerk`
- `board_train`
- `cross_echo_gate`
- `face_shadow`

## 观察到的成功行为

- 新游戏开场通过标准 `GameRuntime` 发布并写入 TurnRecord。
- 售票员保持克制隐喻式说话风格，没有直接替玩家回答归途。
- 玩家自由表达“回家完成拖欠的道歉”后，Pi 能把语义与世界主题联系起来。
- 回声检票廊在未揭示出口前确实阻止北行。
- Prompt 补充精确 `set_exit` schema 后，Pi 正确提交权威出口操作。
- 重启后 DM Session、权威状态、Journal、目标和已揭示出口保持连续。
- 最后冲突一次性结构化结算，生命从 100 降至 86。
- `face_shadow` 完成后，Pi 依据持有车票和已明确承认归途，选择了允许的 `return_with_ticket`。
- 终局后普通故事行动被阻止，但状态和退出仍可使用。

## 真实游玩发现并修复的问题

### 1. 开放式障碍缺少精确 GM 操作提示

第一次坦白时，Pi 叙述了进展，但没有提交 `set_exit`，导致北向出口仍不存在。

修复：

- 当前房间含 `open_ended_obstacle` tag 时，Prompt 明确提醒不能只叙述道路出现。
- Prompt 列出 `set_exit`、`record_fact`、`apply_condition`、`adjust_parameter` 和 `complete_objective` 的精确 JSON schema。

### 2. 重启后运行时 Proposal ID 冲突

旧实现的 `nextLegacyProposalId()` 使用进程内递增计数。重启后 ID 从头开始，与 Journal 中已恢复的 Proposal ID 冲突，导致新移动和回合推进被误判为历史重试。

修复：

- 运行时 Proposal/Correlation ID 改用 UUID。
- 新增 UUID 格式和唯一性回归测试。

修复提交：`7b4afe8 fix: close playtest settlement gaps`。

### 3. 叙述提前宣告终局但未提交 Outcome

第一次干净候选中，阴影被击败后 Pi 叙述“列车终于载你归去”，但没有设置 `outcomeReached`，导致权威状态仍无 Outcome。

修复：Prompt 现在明确要求，如果叙述声称玩家已经离开、列车已经载其归去、故事失败或身份转化，就必须在同一响应提交允许的 Outcome；否则只能描述尚未完成的进展。

修复提交：`1f18c7b fix: require authoritative outcome narration`。

## 后续内容改进

以下不是通用 Engine blocker：

- `echo_mark` 已可用，但本次成功路径没有强制施加；后续可设计一条部分成功或调查路径验证其叙事价值。
- 迷失旅客目前主要提供氛围和战斗威胁，可继续补充非战斗互动 Persona。
- 需要再测试至少一个无票失败 Outcome 和一个售票员死亡后的替代路线。
