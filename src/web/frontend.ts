/// <reference lib="dom" />

type World = { id: string; name: string; description?: string; protagonists: Array<{ id: string; name: string; summary: string }>; defaultProtagonistId?: string };
type Output = { kind: string; text?: string; title?: string; outcome?: { title: string; summary: string } };
type View = any;

const root = document.querySelector<HTMLElement>("#app")!;
let worlds: World[] = [];
let game: { worldId: string; token: string } | null = loadGame();
let view: View | null = null;
let transcript: Array<{ type: string; text: string }> = [];

await boot();

async function boot() {
  renderLoading("正在连接车站……");
  try {
    worlds = await api("/api/worlds");
    if (game) {
      const resumed = await api(`/api/games/${game.worldId}`, { token: game.token });
      view = resumed.state;
      transcript = resumed.history ?? [];
      transcript.push({ type: "system", text: `已恢复存档 ${game.worldId}` });
      renderGame();
    } else renderSetup();
  } catch (error) {
    game = null;
    localStorage.removeItem("mud-pi-game");
    renderSetup(errorMessage(error));
  }
}

function renderSetup(error = "") {
  const first = worlds[0];
  root.innerHTML = `<section class="setup shell">
    <div class="brand"><span class="sigil">◈</span><div><h1>mud-pi</h1><p>一位会记得你的持久 Pi 地下城主</p></div></div>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    <form id="new-game">
      <label>冒险世界<select name="worldPack">${worlds.map((world) => `<option value="${world.id}">${escapeHtml(world.name)}</option>`).join("")}</select></label>
      <div id="world-copy"><p>${escapeHtml(first?.description ?? "选择一个世界，然后让 Pi DM 为你展开只属于这次游戏的故事。")}</p></div>
      <label>主角<select name="protagonistId"></select></label>
      <label>玩家称呼<input name="playerName" maxlength="24" placeholder="旅行者" /></label>
      <button type="submit">开始冒险</button>
    </form>
    <p class="notice">匿名测试版本会记录游戏操作、AI 请求与响应，用于分析和优化系统。</p>
  </section>`;
  const form = root.querySelector<HTMLFormElement>("#new-game")!;
  const worldSelect = form.elements.namedItem("worldPack") as HTMLSelectElement;
  const protagonistSelect = form.elements.namedItem("protagonistId") as HTMLSelectElement;
  const updateWorld = () => {
    const world = worlds.find((candidate) => candidate.id === worldSelect.value)!;
    root.querySelector("#world-copy")!.innerHTML = `<p>${escapeHtml(world.description ?? "选择一个世界，然后让 Pi DM 为你展开只属于这次游戏的故事。")}</p>`;
    protagonistSelect.innerHTML = world.protagonists.map((profile) => `<option value="${profile.id}" ${profile.id === world.defaultProtagonistId ? "selected" : ""}>${escapeHtml(profile.name)} — ${escapeHtml(profile.summary)}</option>`).join("");
  };
  worldSelect.addEventListener("change", updateWorld);
  updateWorld();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    renderLoading("Pi DM 正在铺开冒险桌面……");
    try {
      const created = await api("/api/games", {
        method: "POST",
        body: { worldPack: data.get("worldPack"), protagonistId: data.get("protagonistId"), playerName: data.get("playerName") },
      });
      game = { worldId: created.state.worldId, token: created.token };
      localStorage.setItem("mud-pi-game", JSON.stringify(game));
      view = created.state;
      addOutputs(created.outputs);
      renderGame();
    } catch (err) { renderSetup(errorMessage(err)); }
  });
}

function renderGame() {
  root.innerHTML = `<div class="game shell">
    <header><div class="brand small"><span class="sigil">◈</span><div><h1>mud-pi</h1><p>${escapeHtml(view.worldName)} · 第 ${view.turn} 轮</p></div></div><button id="new-save" class="ghost">新游戏</button></header>
    <section class="board">
      <aside class="panel state"><h2>${escapeHtml(view.player.name)}</h2><p class="lifecycle">${escapeHtml(view.player.lifecycle)}</p><div class="stats">${Object.entries(view.player.stats).map(([key, value]) => `<span><b>${escapeHtml(key)}</b>${value}</span>`).join("")}</div><h3>背包</h3><ul>${view.player.inventory.map((item: any) => `<li>${item.equipped ? "◆ " : ""}${escapeHtml(item.name)}</li>`).join("") || "<li class=muted>空</li>"}</ul><h3>目标</h3><ul>${view.objectives.map((objective: any) => `<li class="${objective.status}">${objective.status === "completed" ? "✓" : "○"} ${escapeHtml(objective.title)}</li>`).join("")}</ul></aside>
      <section class="story"><div id="transcript">${transcript.map((entry) => `<article class="${entry.type}">${escapeHtml(entry.text)}</article>`).join("")}</div><form id="command"><textarea name="input" rows="2" maxlength="2000" placeholder="描述你的行动……例如：我把旧车票放在窗口上，但没有松手"></textarea><button type="submit">行动</button></form></section>
      <aside class="panel room"><p class="eyebrow">当前位置</p><h2>${escapeHtml(view.room.title)}</h2><p>${escapeHtml(view.room.desc)}</p><h3>出口</h3><div class="chips">${view.room.exits.map((exit: string) => `<button class="chip" data-command="向${direction(exit)}走">${escapeHtml(exit)}</button>`).join("") || "无"}</div><h3>在场</h3><p>${view.room.npcs.map((npc: any) => escapeHtml(npc.name)).join("、") || "无人"}</p><h3>物品</h3><p>${view.room.items.map((item: any) => escapeHtml(item.name)).join("、") || "无"}</p>${view.outcome ? `<div class="outcome"><b>${escapeHtml(view.outcome.title)}</b><p>${escapeHtml(view.outcome.summary)}</p></div>` : ""}</aside>
    </section>
  </div>`;
  const transcriptElement = root.querySelector("#transcript")!;
  transcriptElement.scrollTop = transcriptElement.scrollHeight;
  root.querySelector("#new-save")!.addEventListener("click", () => { if (confirm("创建新游戏？当前存档仍会保留，但浏览器将不再自动恢复它。")) { localStorage.removeItem("mud-pi-game"); game = null; view = null; transcript = []; renderSetup(); } });
  root.querySelectorAll<HTMLElement>("[data-command]").forEach((button) => button.addEventListener("click", () => submitCommand(button.dataset.command!)));
  root.querySelector<HTMLFormElement>("#command")!.addEventListener("submit", (event) => { event.preventDefault(); const input = new FormData(event.currentTarget as HTMLFormElement).get("input")?.toString().trim(); if (input) submitCommand(input); });
}

async function submitCommand(input: string) {
  transcript.push({ type: "player", text: `你：${input}` });
  renderGame();
  const form = root.querySelector<HTMLFormElement>("#command")!;
  form.classList.add("busy");
  form.querySelector("textarea")!.setAttribute("disabled", "true");
  form.querySelector("button")!.textContent = "Pi 思考中…";
  try {
    const result = await api(`/api/games/${game!.worldId}/input`, { method: "POST", token: game!.token, body: { input } });
    view = result.state;
    addOutputs(result.outputs);
    renderGame();
  } catch (error) {
    transcript.push({ type: "error", text: errorMessage(error) });
    renderGame();
  }
}

function addOutputs(outputs: Output[]) {
  for (const output of outputs) {
    if (output.kind === "narration" || output.kind === "direct_reply") transcript.push({ type: output.kind, text: output.text ?? "" });
    else if (output.kind === "objective_completed") transcript.push({ type: "objective", text: `目标完成：${output.title}` });
    else if (output.kind === "story_outcome") transcript.push({ type: "outcome", text: `${output.outcome?.title}\n${output.outcome?.summary}` });
  }
}

async function api<T = any>(path: string, options: { method?: string; token?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, { method: options.method ?? "GET", headers: { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(options.body ? { "content-type": "application/json" } : {}) }, body: options.body ? JSON.stringify(options.body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `请求失败 (${response.status})`);
  return data;
}

function loadGame() { try { return JSON.parse(localStorage.getItem("mud-pi-game") ?? "null"); } catch { return null; } }
function renderLoading(text: string) { root.innerHTML = `<section class="loading"><span class="sigil pulse">◈</span><p>${escapeHtml(text)}</p></section>`; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
function escapeHtml(value: unknown) { return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!); }
function direction(exit: string) { return ({ north: "北", south: "南", east: "东", west: "西", up: "上", down: "下" } as Record<string, string>)[exit] ?? exit; }
