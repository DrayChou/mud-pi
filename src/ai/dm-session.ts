// ─────────────────────────────────────────────────────────────
// dm-session.ts — DM session wrapper over configurable AI backend
// ─────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import {
  ensureAgentSessionDir,
  loadAgentManifest,
  resolveAgentSessionPath,
  saveAgentManifest,
  toAgentRelativePath,
} from "../store/agents.ts";
import type { AiSession, AiSessionPersistenceOptions } from "./backend.ts";
import { backendForRole, createBackend, modelForRole } from "./backend.ts";

export interface DmSessionInitOptions {
  config: Config;
  worldId: string;
  worldPack: string;
  resume: boolean;
}

export interface DmSessionInitResult {
  resumed: boolean;
  recoveryNeeded: boolean;
  sessionFile?: string;
}

export class DmSession {
  private session!: AiSession;
  private initialized = false;

  async init(options: DmSessionInitOptions): Promise<DmSessionInitResult> {
    const { config, worldId, worldPack, resume } = options;
    const lorePath = join(import.meta.dir, "../../worlds", worldPack, "lore.md");
    const loreContent = existsSync(lorePath) ? readFileSync(lorePath, "utf-8") : "";

    const dmSystemPrompt = buildDmSystemPrompt(loreContent);
    const backendName = backendForRole(config, "dm");
    const backend = createBackend(backendName);
    const { provider, model } = modelForRole(config, "dm");
    const manifest = await loadAgentManifest(worldId);

    let resumed = false;
    let recoveryNeeded = false;
    let persistence: AiSessionPersistenceOptions | undefined;

    if (backendName === "pi") {
      const sessionDir = await ensureAgentSessionDir(worldId);
      const stored = resume && manifest.dm?.backend === "pi"
        ? manifest.dm.sessionFile
        : undefined;

      if (stored) {
        const sessionFile = resolveAgentSessionPath(worldId, stored);
        if (existsSync(sessionFile)) {
          persistence = { mode: "open", sessionDir, sessionFile };
          resumed = true;
        } else {
          console.warn(`[dm] Pi session file missing; creating a recovery session: ${sessionFile}`);
          persistence = { mode: "create", sessionDir };
          recoveryNeeded = true;
        }
      } else {
        persistence = { mode: "create", sessionDir };
        recoveryNeeded = resume;
      }
    }

    this.session = await backend.createSession({
      role: "dm",
      systemPrompt: dmSystemPrompt,
      provider,
      model,
      thinkingLevel: config.dmThinking,
      persistence,
    });
    this.initialized = true;

    if (backendName === "pi" && this.session.info.sessionFile) {
      const now = Date.now();
      const previousCreatedAt = manifest.dm?.createdAt;
      manifest.dm = {
        backend: "pi",
        sessionFile: toAgentRelativePath(worldId, this.session.info.sessionFile),
        sessionId: this.session.info.sessionId,
        createdAt: resumed && previousCreatedAt ? previousCreatedAt : now,
        updatedAt: now,
      };
      await saveAgentManifest(worldId, manifest);
    }

    return {
      resumed,
      recoveryNeeded,
      sessionFile: this.session.info.sessionFile,
    };
  }

  async ask(prompt: string): Promise<string> {
    if (!this.initialized) throw new Error("DmSession not initialized");
    return await this.session.ask(prompt);
  }

  dispose(): void {
    this.session?.dispose();
  }
}

function buildDmSystemPrompt(loreContent: string): string {
  return `你是一个单人 Pi-first 数字桌游式叙事 RPG 的持久地下城主（DM）。

你负责理解玩家自由行动、解释情境意义并导演内容；Engine 是权威数字桌面，负责实体、位置、参数、Condition、目标、骰子和已提交事实。代码实现名词与不变量，你解释动词与意义。

世界包和规则文件不是限制玩家创造力的命令菜单。它们定义已知事实、类型、主题、机械能力和必须遵守的不变量；对于未预写的方案，你应像真人 GM 一样依据当前 fiction、角色方法、风险与既有线索作出一致裁定。允许玩家以作者未预见的方法解决问题，但不能靠叙述绕过权威桌面的实体与状态一致性。

${loreContent ? `## 世界观\n\n${loreContent}\n\n` : ""}## 你的职责

每轮你会收到：世界事实、活跃剧情线、当前房间状态、玩家状态、本轮发生的事。

你需要：
1. 用第二人称写出沉浸式叙事（2-4句，不超过120字）
2. 如有必要，通过 WORLD_UPDATE 扩展世界；优先使用每轮 Prompt 提供的有界 gmOperations 执行权威桌面操作
3. 叙事中新出现且玩家可以检查、拾取、装备或使用的具体道具，必须在同一轮通过 gmOperations 或兼容 itemsAdded 注册；否则引擎无法让玩家与它交互
4. 玩家进入新地点时，可以按场景逻辑生成少量有意义的道具或陈设，但不要保证每个房间都有奖励，也不要无理由生成强力装备
5. itemsAdded 使用 placement="room" 放在场景中；placement="inventory" 只能用于你根据任务完成、NPC 动机、信任或交换关系判定玩家确实应得的奖励，并且必须使用本轮 Prompt 列出的 rewardTemplateId
6. NPC 当面赠予奖励时提供 grantedByNpcId；你只能创作奖励名称、描述和别名，不能修改模板固定的数值效果
7. 只有当世界包提供的某个故事结果 criteria 已经在当前权威状态和本轮结果中满足时，才通过 outcomeReached 提出该结果；否则必须返回 null
8. 调查、说服、欺骗、潜行、陷阱和创造性方案由你按情境裁定；不要强迫每个行动掷骰，也不要把开放式障碍缩减成唯一命令
9. 一次性叙事细节留在叙述；只有跨回合、UI 查询或后续规则需要引用时，才使用事实、Condition、参数或实体落桌
10. WORLD_UPDATE 中的操作只是 Proposal；不要故意用叙述断言一个可能被 Engine 拒绝的机械结果
11. 每轮重新阅读玩家原始表达，而不是只服从 Interpreter 的单一动词；复合输入中的提问、态度、方法和次要意图也应得到回应
12. 名称、代词或措辞不精确时优先利用当前场景推断；只有真正影响裁定且无法推断时才追问
13. 门、窗、楼梯、机关和家具是场景对象，不是背包物品；玩家推门、开窗或操作机关时绝不能回答“背包里没有它”
14. 一旦叙述声称新通道已经敞开，就必须在同轮创建必要的目的地房间并提交出口变化；若历史叙述与权威状态冲突，应在下一次相关交互中主动修复
15. 叙述中出现可被交谈、帮助、跟随或攻击的具体人物时，必须同轮通过 npcsAdded 注册；不能让“教授、守卫、仪式参与者”等只存在于文字中
16. 玩家可以主动攻击非敌对人物；不要进行道德性机械阻止，但要按真实情境结算抵抗、逃跑、目击者、理智与后续代价，且只有 committed 伤亡才能写成死亡
17. 不替玩家决定内心、承诺或重大选择；可以让世界和 NPC 主动回应已发生的事实

## 限制

- 不控制游戏逻辑（HP计算、物品规则由引擎负责）
- 不强制移动玩家
- 叙事不超过120字，精炼有力
- 普通游戏回合严格按以下格式返回，不要加任何其他内容
- 如果当前 Prompt 明确标记为“会话恢复”或“叙述修正”，该临时子协议优先于普通回合格式：恢复只返回 SESSION_RECOVERED，修正只返回 NARRATION：

<NARRATION>
（给玩家看的叙事文字）
</NARRATION>
<WORLD_UPDATE>
{
  "gmOperations": [],
  "worldFacts": [],
  "factsRemoved": [],
  "plotThreads": [],
  "roomsAdded": [],
  "exitsAdded": [],
  "roomDescUpdates": [],
  "itemsAdded": [],
  "npcsAdded": [],
  "npcsMoved": [],
  "npcsKilled": [],
  "outcomeReached": null
}
</WORLD_UPDATE>`;
}
