# 剧本化冲突算法调研与设计

## 调研结论

成熟 RPG 通常不会用一个 `0x–2x` 连续随机数同时表达命中、失手和暴击，因为这样会把三个可调维度绑死。更常见的流水线是：

1. 单独计算命中率并掷命中骰；
2. 命中后计算基础伤害；
3. 单独判断暴击；
4. 非暴击伤害再乘较窄的随机浮动。

### Pokémon Showdown

Pokémon Showdown 会先结合攻击者命中等级与目标闪避等级修正 accuracy，再单独用 `randomChance(accuracy, 100)` 判断是否失手：

- [`sim/battle-actions.ts#L712-L739`](https://github.com/smogon/pokemon-showdown/blob/393d5c8675f28cacceea1fb1a4d976205c3540b1/sim/battle-actions.ts#L712-L739)

暴击使用另一套概率表，不与普通命中骰共用：

- [`sim/battle-actions.ts#L1623-L1646`](https://github.com/smogon/pokemon-showdown/blob/393d5c8675f28cacceea1fb1a4d976205c3540b1/sim/battle-actions.ts#L1623-L1646)

普通伤害随机浮动约为基础伤害的 85%–100%，而不是从 0% 到 200% 连续均匀抽取：

- [`sim/battle.ts#L2388-L2391`](https://github.com/smogon/pokemon-showdown/blob/393d5c8675f28cacceea1fb1a4d976205c3540b1/sim/battle.ts#L2388-L2391)

### Battle for Wesnoth

Wesnoth 将地形防御、武器能力等先合成为独立的 `chance_to_hit`，再限制到 0–100：

- [`src/actions/attack.cpp#L169-L181`](https://github.com/wesnoth/wesnoth/blob/d2f4a7e12df26932bbb0a4c9a4c1d840ca8a4df4/src/actions/attack.cpp#L169-L181)

真正出手时，游戏单独抽取命中随机数；未命中时伤害直接为 0，命中后才使用武器伤害：

- [`src/actions/attack.cpp#L866-L894`](https://github.com/wesnoth/wesnoth/blob/d2f4a7e12df26932bbb0a4c9a4c1d840ca8a4df4/src/actions/attack.cpp#L866-L894)

它还保存命中与伤害结果以支持 replay，这与 mud-pi 的“seed + 结构化帧 + 最终 Mutation”方向一致。

## mud-pi 采用的默认自动战斗算法

世界包可配置 `gauge-random-v1`。默认流程：

```text
速度行动条达到 100
→ 独立命中骰
→ 未命中：0 伤害
→ 命中后独立暴击骰
→ 暴击：2x
→ 普通命中：0.75x–1.25x 随机浮动
→ 应用攻击、防御与幸运修正
```

默认命中率：

```text
baseHitChance
+ (accuracy - evasion) × accuracyScale
+ (attackerLuck - defenderLuck) × luckHitScale
```

默认暴击率：

```text
baseCritChance + attackerLuck × luckCritScale
```

幸运同时轻微影响普通伤害浮动，但不会让普通伤害越过世界包声明的上下限。

这保留了用户期望的两个端点：

- `0x`：命中骰失败，明确记录为 miss；
- `2x`：暴击骰成功，明确记录为 critical。

但不会让普通攻击在 0–2 倍之间剧烈均匀摆动。

## 可复现随机

每次战斗 seed 由权威上下文确定：

```text
worldId + turn + targetId
```

每个展示帧保存：

- `hitChance`
- `hitRoll`
- `hit`
- `critical`
- `damageMultiplier`
- `damage`
- `targetPoolAfter`

读档重放和客户端动画不需要重新抽随机数。

风险提示使用 32 个派生 seed 做快速胜率采样，但玩家可见文案不显示“数据模拟”或裸露系统术语。世界包可以提供沉浸式模板：

```json
{
  "likelyFailureWarning": "你本能地意识到，贸然与{target}正面对抗，很可能无法全身而退。",
  "dangerousWarning": "面对{target}，一种强烈的不安提醒你：即使取胜，也可能付出沉重代价。"
}
```

## 世界包拥有冲突规则

### 自动战斗世界

```json
{
  "conflictRules": {
    "mode": "auto_combat",
    "algorithm": "gauge-random-v1",
    "baseHitChance": 0.75,
    "normalDamageMin": 0.75,
    "normalDamageMax": 1.25,
    "critMultiplier": 2
  }
}
```

### Disco-like 掷骰世界

```json
{
  "conflictRules": {
    "mode": "dice_check",
    "dice": { "count": 2, "sides": 6 },
    "criticalSuccess": "all_max",
    "criticalFailure": "all_min"
  }
}
```

此模式不进入生命值战斗。通用解析器 `simulateDiceCheck()` 计算：

```text
骰子总和 + 技能/属性修正 >= 难度
```

世界包仍负责决定使用哪个技能、难度、失败后果和是否允许重试。

### 无数值冲突世界

```json
{
  "conflictRules": { "mode": "none" }
}
```

`attack` 不会偷偷回退到默认 HP 战斗，而会要求通过对话、选择或叙事行动解决。

## 架构边界

- 世界包定义冲突模式与参数。
- Engine 执行随机、校验和最终 Mutation。
- DM 解释结果，但不能改写命中、暴击、伤害或胜负。
- 前端只消费结构化帧，不重复计算。
- Pi Session 不负责抽骰或修改权威数值。
