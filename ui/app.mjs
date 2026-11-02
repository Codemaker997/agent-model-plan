// 配装 · 前端（整页卡）
// 两个视图：模型配装（角色卡 × 默认模型）、钥匙串（各供应商的多套密钥）
// 后端约定：GET /agents /models /presets /vault，POST /apply /presets /vault/entries /vault/reveal 等

const SEP = "\u0000";

let hana = null;
let toastTimer = null;

const state = {
  agents: [],
  providers: [],      // [{ provider, displayName, models: [{ id, displayName }] }]
  presets: [],
  currentPresetId: null,
  draft: {},          // agentId -> { id, provider } | null
  vault: [],          // [{ id, displayName, mount, entries }]
  vaultSel: null,
  adding: false,
  loadErrors: [],     // 启动时读取失败的项目，任一成功都能继续用
};

/* ---------------- 基础 ---------------- */

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}超时：${Math.round(ms / 1000)} 秒没有响应`)),
      ms
    );
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

async function getHana() {
  if (hana) return hana;
  const mod = await import("./sdk/ui.js");
  let created = null;
  if (typeof mod.createHanaAppUiSdk === "function") {
    try {
      created = mod.createHanaAppUiSdk({ targetWindow: window });
    } catch (err) {
      // 新版 SDK 会校验页面路由，校验不通过时回落到 SDK 自带的单例
      console.warn("[配装] createHanaAppUiSdk 失败，回落默认实例：", err);
      created = mod.hana || null;
    }
  } else {
    created = mod.hana || null;
  }
  if (!created) throw new Error("App SDK 没有导出可用的 hana 实例");
  hana = created;
  if (typeof hana.ready === "function") {
    // 握手只作为门面，等不到也必须继续，否则页面会永远停在加载文案上
    try {
      await withTimeout(hana.ready(), 3000, "与宿主握手");
    } catch (err) {
      console.warn("[配装] 握手未完成，继续请求：", err);
    }
  }
  return hana;
}

async function api(path, init) {
  const ui = await getHana();
  if (!ui || !ui.api || typeof ui.api.fetch !== "function") {
    throw new Error("App SDK 没有提供 api.fetch");
  }
  const res = await withTimeout(ui.api.fetch(path, init), 20000, `请求 ${path} `);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
  if (!res.ok || (body && body.ok === false)) {
    const err = body && body.error;
    throw new Error(typeof err === "string" ? err : (err && err.message) || `请求失败 (${res.status})`);
  }
  return body;
}

const postJson = (path, payload, method = "POST") =>
  api(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

function toast(message, tone = "info") {
  const node = document.getElementById("pj-toast");
  node.textContent = message;
  node.dataset.tone = tone;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2600);
}

function confirmDialog(title, body, confirmText = "确认") {
  return new Promise((resolve) => {
    const dialog = document.getElementById("pj-modal");
    const ok = document.getElementById("pj-modal-ok");
    const cancel = document.getElementById("pj-modal-cancel");
    document.getElementById("pj-modal-title").textContent = title;
    document.getElementById("pj-modal-body").textContent = body;
    ok.textContent = confirmText;
    dialog.hidden = false;

    const finish = (value) => {
      dialog.hidden = true;
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      dialog.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onBackdrop = (e) => { if (e.target === dialog) finish(false); };
    const onKey = (e) => { if (e.key === "Escape") finish(false); };
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    dialog.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
  });
}

/* ---------------- 供应商图标 ---------------- */

const PROVIDER_COLORS = {
  deepseek: "#4D6BFE",
  "deepseek-responses": "#4D6BFE",
  zhipu: "#2A63E8",
  minimax: "#E4573D",
  "minimax-token-plan": "#E4573D",
  moonshot: "#0F9E7E",
  kimi: "#0F9E7E",
  "kimi-coding": "#0F9E7E",
  volcengine: "#1664FF",
  "volcengine-coding": "#1664FF",
  sensenova: "#6B4FD8",
  "opencode-go": "#5C6B7A",
  opencode: "#5C6B7A",
  tencent: "#2E7BF6",
  qwen: "#615CED",
  dashscope: "#615CED",
  openai: "#10A37F",
  google: "#4285F4",
  gemini: "#4285F4",
  anthropic: "#D97757",
  siliconflow: "#6E5AF0",
  openrouter: "#6467F2",
  mistral: "#FA5210",
  xai: "#111111",
  groq: "#F55036",
};

// 中文或有差异的供应商 id → 图标文件名
const PROVIDER_ICON_ALIAS = {
  "火山方舟": "volcengine",
  "腾讯云": "tencent",
  "阿里云百炼": "qwen",
  "opencode-go": "opencode",
};

function providerColor(id) {
  const key = PROVIDER_ICON_ALIAS[id] || id;
  if (PROVIDER_COLORS[key]) return PROVIDER_COLORS[key];
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${hash} 46% 52%)`;
}

const iconCache = new Map();

function providerIcon(id, label, large) {
  const color = providerColor(id);
  const node = el("span", "pj-pico" + (large ? " lg" : ""));
  node.title = label || id;
  node.dataset.p = id;
  node.style.background = color;
  node.textContent = String(label || id || "?").trim().slice(0, 1).toUpperCase();

  const file = PROVIDER_ICON_ALIAS[id] || id;
  const url = `./assets/providers/${file}.svg`;
  const apply = () => {
    node.textContent = "";
    node.style.webkitMaskImage = `url("${url}")`;
    node.style.maskImage = `url("${url}")`;
    node.style.webkitMaskRepeat = "no-repeat";
    node.style.maskRepeat = "no-repeat";
    node.style.webkitMaskPosition = "center";
    node.style.maskPosition = "center";
    node.style.webkitMaskSize = "contain";
    node.style.maskSize = "contain";
    node.style.background = color;
  };

  const cached = iconCache.get(id);
  if (cached === true) apply();
  else if (cached !== false) {
    const probe = new Image();
    probe.onload = () => { iconCache.set(id, true); apply(); };
    probe.onerror = () => { iconCache.set(id, false); };
    probe.src = url;
  }
  return node;
}

/* ---------------- 剪贴板 ---------------- */

async function copyText(text) {
  // 一、宿主通道
  const h = await getHana();
  if (h && h.clipboard && typeof h.clipboard.writeText === "function") {
    try {
      const receipt = await h.clipboard.writeText(text);
      if (!receipt || receipt.written !== false) return;
    } catch (_) {
      /* 往下试 */
    }
  }

  // 二、浏览器剪贴板（在卡片槽位里常被 permissions policy 拦）
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch (_) {
    /* 往下试 */
  }

  // 三、老 API 兜底：不受 permissions policy 管辖，靠用户手势
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  ta.style.top = "0";
  document.body.append(ta);
  ta.select();
  ta.setSelectionRange(0, ta.value.length);
  let done = false;
  try {
    done = document.execCommand("copy");
  } catch (_) {
    done = false;
  }
  ta.remove();
  if (done) return;

  throw new Error("这个环境不允许直接写剪贴板，请用下面的“显示”按钮手动复制");
}

/* ---------------- 数据模型 ---------------- */

const sameModel = (a, b) => {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.id === b.id && (a.provider || "") === (b.provider || "");
};

const modelKey = (m) => (m ? `${m.provider || ""}${SEP}${m.id || ""}` : "");

function decodeKey(key) {
  if (!key) return null;
  const at = key.indexOf(SEP);
  if (at < 0) return null;
  const provider = key.slice(0, at);
  const id = key.slice(at + 1);
  return id ? { id, provider } : null;
}

const currentPreset = () => state.presets.find((p) => p.id === state.currentPresetId) || null;

function assignmentsFromDraft() {
  const out = {};
  for (const [agentId, model] of Object.entries(state.draft)) {
    if (model && model.id) out[agentId] = { id: model.id, provider: model.provider || "" };
  }
  return out;
}

function draftFromAssignments(assignments) {
  const draft = {};
  for (const agent of state.agents) {
    const stored = assignments ? assignments[agent.id] : null;
    draft[agent.id] = stored && stored.id ? { id: stored.id, provider: stored.provider || "" } : null;
  }
  return draft;
}

function providerLabel(id) {
  const hit = state.providers.find((p) => p.provider === id);
  return hit ? hit.displayName : id;
}

/* ---------------- 渲染：模型配装 ---------------- */

function modelCell(model) {
  const box = el("div", "pj-mid");
  if (!model) {
    box.append(el("span", "pj-none", "跟随默认"));
    return box;
  }
  box.append(providerIcon(model.provider, providerLabel(model.provider)));
  box.append(el("span", "pv", providerLabel(model.provider)));
  const id = el("span", "id", model.id);
  id.title = model.id;
  box.append(id);
  return box;
}

function renderRow(agent) {
  const tr = el("tr");
  const picked = state.draft[agent.id] || null;
  tr.dataset.dirty = sameModel(picked, agent.currentModel) ? "0" : "1";

  const tdWho = el("td");
  const who = el("div", "pj-who");
  const avatar = el("span", "pj-avatar");
  if (agent.yuan) avatar.dataset.yuan = agent.yuan;
  if (agent.avatar) {
    const img = el("img");
    img.src = agent.avatar;
    img.alt = "";
    avatar.append(img);
  } else {
    avatar.textContent = String(agent.name || agent.id).trim().slice(0, 1).toUpperCase();
  }
  const text = el("div");
  const name = el("div", "pj-name", agent.name || agent.id);
  name.title = `${agent.name || agent.id} · ${agent.id}`;
  text.append(name);
  const marks = el("div", "pj-marks");
  if (agent.isPrimary) marks.append(el("span", "pj-mark on", "主控"));
  if (agent.isCurrent) marks.append(el("span", "pj-mark", "当前"));
  if (marks.childNodes.length) text.append(marks);
  who.append(avatar, text);
  tdWho.append(who);

  const tdNow = el("td");
  if (agent.currentModel) tdNow.append(modelCell(agent.currentModel));
  else {
    const none = el("span", "pj-none", agent.readError ? "读取失败" : "跟随默认");
    if (agent.readError) none.title = agent.readError;
    tdNow.append(none);
  }

  const tdPick = el("td");
  const pickWrap = el("div", "pj-mid");
  const select = el("select", "pj-pick");
  select.setAttribute("aria-label", `${agent.name || agent.id} 的默认模型`);
  select.append(new Option("不指定", ""));
  for (const group of state.providers) {
    const og = el("optgroup");
    og.label = group.displayName;
    for (const m of group.models) {
      og.append(new Option(m.displayName || m.id, modelKey({ id: m.id, provider: m.provider })));
    }
    select.append(og);
  }
  select.value = picked ? modelKey(picked) : "";

  pickWrap.append(select);
  const iconRef = { value: null };
  const mountIcon = (model) => {
    const node = providerIcon(model ? model.provider : "", model ? providerLabel(model.provider) : "");
    node.style.visibility = model ? "visible" : "hidden";
    if (iconRef.value) iconRef.value.replaceWith(node);
    else pickWrap.append(node);
    iconRef.value = node;
  };
  mountIcon(picked);

  select.addEventListener("change", () => {
    state.draft[agent.id] = decodeKey(select.value);
    refreshRow(tr, agent, iconRef, pickWrap);
    renderCaption();
  });
  tdPick.append(pickWrap);

  const tdState = el("td");
  const badge = el("span", "pj-state");
  tdState.append(badge);

  tr.append(tdWho, tdNow, tdPick, tdState);
  paintBadge(badge, agent);
  return tr;
}

function paintBadge(badge, agent) {
  const picked = state.draft[agent.id] || null;
  if (!picked) {
    badge.dataset.k = agent.currentModel ? "empty" : "same";
    badge.textContent = agent.currentModel ? "未指定" : "沿用默认";
    return;
  }
  if (sameModel(picked, agent.currentModel)) {
    badge.dataset.k = "same";
    badge.textContent = "一致";
  } else {
    badge.dataset.k = "dirty";
    badge.textContent = agent.currentModel ? "待应用" : "待写入";
  }
}

function refreshRow(tr, agent, iconRef, wrap) {
  const picked = state.draft[agent.id] || null;
  tr.dataset.dirty = sameModel(picked, agent.currentModel) ? "0" : "1";
  const badge = tr.querySelector(".pj-state");
  if (badge) paintBadge(badge, agent);
  if (iconRef) {
    const node = providerIcon(picked ? picked.provider : "", picked ? providerLabel(picked.provider) : "");
    node.style.visibility = picked ? "visible" : "hidden";
    if (iconRef.value) iconRef.value.replaceWith(node);
    else if (wrap) wrap.append(node);
    iconRef.value = node;
  }
}

function dirtyAgents() {
  return state.agents.filter((a) => {
    const picked = state.draft[a.id] || null;
    return picked && picked.id && !sameModel(picked, a.currentModel);
  });
}

function renderCaption() {
  const dirty = dirtyAgents();
  const total = state.agents.length;
  const box = document.getElementById("pj-count");
  box.innerHTML = "";
  if (dirty.length) {
    box.append(el("span", "dirty", `${dirty.length} 处待应用`), document.createTextNode(` / 共 ${total} 张角色卡`));
  } else {
    box.textContent = `${total} 张角色卡，实况与配装一致`;
  }
  document.getElementById("pj-apply").disabled = dirty.length === 0;
}

function renderModels() {
  const select = document.getElementById("pj-preset");
  select.replaceChildren();
  if (!state.presets.length) {
    select.append(new Option("（还没有配装）", ""));
    select.disabled = true;
  } else {
    select.disabled = false;
    for (const p of state.presets) select.append(new Option(p.name, p.id));
    select.value = state.currentPresetId || "";
  }

  const nameInput = document.getElementById("pj-name");
  const preset = currentPreset();
  nameInput.value = preset ? preset.name : "";
  nameInput.disabled = !preset;

  const tbody = document.getElementById("pj-tbody");
  tbody.replaceChildren();
  if (!state.agents.length) {
    const tr = el("tr");
    const td = el("td", "pj-ph", "没有读到角色卡。若刚授权，请重新加载本应用。");
    td.colSpan = 4;
    tr.append(td);
    tbody.append(tr);
  } else {
    for (const agent of state.agents) tbody.append(renderRow(agent));
  }

  renderCaption();

  const models = state.providers.reduce((n, p) => n + p.models.length, 0);
  const withAvatar = state.agents.filter((a) => a.avatar).length;
  document.getElementById("pj-sub").textContent = state.loadErrors && state.loadErrors.length
    ? `读取失败：${state.loadErrors[0]}${state.loadErrors.length > 1 ? `（另有 ${state.loadErrors.length - 1} 项）` : ""}`
    : `${state.agents.length} 张角色卡 · ${models} 个可用模型 · ${state.presets.length} 套配装 · ${countKeys()} 组密钥 · 头像 ${withAvatar}/${state.agents.length}${withAvatar < state.agents.length ? "（点「补头像」）" : ""}`;

}

function countKeys() {
  return state.vault.reduce((n, p) => n + (p.entries ? p.entries.length : 0), 0);
}

/* ---------------- 渲染：钥匙串 ---------------- */

function maskText(entry) {
  const box = el("span", "pj-ksecret");
  box.append(document.createTextNode("••••••••••••"));
  const tail = el("span");
  tail.textContent = entry.tail || "····";
  tail.style.color = "var(--pj-text)";
  box.append(tail);
  box.title = `共 ${entry.length} 位，只显示末四位`;
  return box;
}

function renderVault() {
  const rail = document.getElementById("pj-rail");
  const pane = document.getElementById("pj-pane");
  rail.replaceChildren();
  pane.replaceChildren();

  rail.append(el("div", "rt", `供应商 · ${state.vault.length}`));

  if (!state.vault.length) {
    rail.append(el("div", "pj-kempty", "还没有供应商"));
    pane.append(el("div", "pj-kempty", "读不到供应商目录。检查 app/models.read 授权后重试。"));
    return;
  }

  if (!state.vaultSel || !state.vault.some((p) => p.id === state.vaultSel)) {
    state.vaultSel = state.vault[0].id;
  }

  for (const provider of state.vault) {
    const item = el("button", "pj-ritem");
    item.type = "button";
    item.setAttribute("aria-current", String(provider.id === state.vaultSel));
    item.append(providerIcon(provider.id, provider.displayName, true));
    item.append(el("span", "rname", provider.displayName));
    const dot = el("span", "rdot" + (provider.mount && provider.mount.mounted ? "" : " off"));
    dot.title = provider.mount && provider.mount.mounted ? "已挂载" : "未挂载";
    item.append(dot);
    item.append(el("span", "rcount", String(provider.entries ? provider.entries.length : 0)));
    item.addEventListener("click", () => {
      state.vaultSel = provider.id;
      state.adding = false;
      renderVault();
    });
    rail.append(item);
  }

  const selected = state.vault.find((p) => p.id === state.vaultSel);
  renderPane(pane, selected);
}

function renderPane(pane, provider) {
  const head = el("div", "pj-phead");
  head.append(providerIcon(provider.id, provider.displayName, true));
  head.append(el("h2", null, provider.displayName));

  const mount = el("span", "mount");
  const m = provider.mount || {};
  if (m.mounted && m.via === "apiKey") {
    mount.append(document.createTextNode("当前挂载 ····"));
    mount.append(el("b", null, m.tail || "????"));
  } else if (m.mounted) {
    mount.append(document.createTextNode("当前挂载（仅请求头）"));
  } else if (m.error) {
    mount.classList.add("bad");
    mount.textContent = m.error;
  } else {
    mount.textContent = "未挂载";
  }
  head.append(mount);
  pane.append(head);

  const list = el("div", "pj-plist");
  const entries = provider.entries || [];
  if (!entries.length) {
    list.append(el("div", "pj-kempty", "这一家还没存过密钥"));
  } else {
    for (const entry of entries) {
      const row = el("div", "pj-krow");
      row.append(el("span", "pj-ktag", entry.label || "未命名"));
      row.append(maskText(entry));
      if (entry.broken) {
        const warn = el("span", "pj-none", "解不开");
        warn.title = "这条记录无法用当前主密钥解开";
        row.append(warn);
      }
      const acts = el("div", "pj-kacts");

      const copy = el("button", "pj-kbtn copy", "复制");
      copy.type = "button";
      copy.addEventListener("click", async () => {
        try {
          const res = await postJson("/vault/reveal", { id: entry.id });
          await copyText(res.secret);
          toast(`已复制「${entry.label}」，去设置里粘贴`);
        } catch (err) {
          toast(String(err.message || err), "error");
        }
      });

      const peek = el("button", "pj-kbtn", "显示");
      peek.type = "button";
      peek.title = "复制不通时，直接看明文并选中";
      peek.addEventListener("click", async () => {
        try {
          const res = await postJson("/vault/reveal", { id: entry.id });
          const box = row.querySelector(".pj-ksecret");
          box.textContent = res.secret;
          box.style.color = "var(--pj-text)";
          try {
            const range = document.createRange();
            range.selectNodeContents(box);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
          } catch (_) {
            /* 选区失败不影响显示 */
          }
          peek.remove();
          const hide = el("button", "pj-kbtn", "隐藏");
          hide.type = "button";
          hide.addEventListener("click", () => renderVault());
          acts.prepend(hide);
        } catch (err) {
          toast(String(err.message || err), "error");
        }
      });

      const rename = el("button", "pj-kbtn", "备注");
      rename.type = "button";
      rename.addEventListener("click", () => startEdit(row, provider, entry));

      const del = el("button", "pj-kbtn danger", "删除");
      del.type = "button";
      del.addEventListener("click", async () => {
        const yes = await confirmDialog("删除密钥", `确定删除「${entry.label}」？只删本机存的那一份，不影响宿主里已挂载的。`, "删除");
        if (!yes) return;
        try {
          await api(`/vault/entries/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
          provider.entries = provider.entries.filter((e) => e.id !== entry.id);
          renderVault();
          renderModels();
          toast("已删除");
        } catch (err) {
          toast(String(err.message || err), "error");
        }
      });

      acts.append(copy, peek, rename, del);
      row.append(acts);
      list.append(row);
    }
  }
  pane.append(list);

  const foot = el("div", "pj-pfoot");
  if (state.adding) {
    const form = el("div", "pj-form");
    const label = el("input", "pj-inp");
    label.placeholder = "标签，比如 公司 / 个人";
    const secret = el("input", "pj-inp secret");
    secret.type = "password";
    secret.placeholder = "粘贴密钥";
    secret.autocomplete = "off";
    const save = el("button", "pj-btn primary", "存下");
    save.type = "button";
    const cancel = el("button", "pj-btn ghost", "取消");
    cancel.type = "button";

    save.addEventListener("click", async () => {
      try {
        const res = await postJson("/vault/entries", {
          providerId: provider.id,
          label: label.value,
          secret: secret.value,
        });
        provider.entries = provider.entries || [];
        provider.entries.push(res.entry);
        state.adding = false;
        renderVault();
        renderModels();
        toast("已存进钥匙串");
      } catch (err) {
        toast(String(err.message || err), "error");
      }
    });
    cancel.addEventListener("click", () => { state.adding = false; renderVault(); });

    form.append(label, secret, save, cancel);
    foot.append(form);
    queueMicrotask(() => label.focus());
  } else {
    const add = el("button", "pj-kadd", "＋ 添加密钥");
    add.type = "button";
    add.addEventListener("click", () => { state.adding = true; renderVault(); });
    foot.append(add);
  }
  pane.append(foot);
}

function startEdit(row, provider, entry) {
  row.replaceChildren();
  const label = el("input", "pj-inp");
  label.value = entry.label || "";
  label.style.flex = "0 1 160px";
  const secret = el("input", "pj-inp secret");
  secret.type = "password";
  secret.placeholder = "留空则不改密钥";
  secret.autocomplete = "off";
  const save = el("button", "pj-btn primary", "保存");
  save.type = "button";
  const cancel = el("button", "pj-btn ghost", "取消");
  cancel.type = "button";

  save.addEventListener("click", async () => {
    try {
      const payload = { label: label.value, note: entry.note || "" };
      if (secret.value.trim()) payload.secret = secret.value;
      const res = await postJson(`/vault/entries/${encodeURIComponent(entry.id)}`, payload, "PUT");
      const index = provider.entries.findIndex((e) => e.id === entry.id);
      if (index >= 0) provider.entries[index] = res.entry;
      renderVault();
      toast("已更新");
    } catch (err) {
      toast(String(err.message || err), "error");
    }
  });
  cancel.addEventListener("click", () => renderVault());

  row.append(label, secret, save, cancel);
  queueMicrotask(() => label.focus());
}

/* ---------------- 视图切换 ---------------- */

function setView(view) {
  state.view = view;
  document.querySelectorAll(".pj-tabs button").forEach((b) => {
    b.setAttribute("aria-selected", String(b.dataset.tab === view));
  });
  document.getElementById("pj-view-models").hidden = view !== "models";
  document.getElementById("pj-view-keys").hidden = view !== "keys";

  // 只保留当前视图的节点，避免隐藏视图继续挂在 DOM 上
  if (view === "models") {
    document.getElementById("pj-rail").replaceChildren();
    document.getElementById("pj-pane").replaceChildren();
    renderModels();
  } else {
    document.getElementById("pj-tbody").replaceChildren();
    renderVault();
  }
}

/* ---------------- 行为 ---------------- */

/* ---------------- 宿主头像 ---------------- */

// 宿主对 /api/agents/:id/avatar 开了免票据 GET 通道，能直取就不必把图打进包里。
// 取不到再回落包内自带的那张，再取不到回落首字母。
const hostAvatarCache = new Map();

async function fetchHostAvatar(agentId) {
  if (hostAvatarCache.has(agentId)) return hostAvatarCache.get(agentId);
  let out = null;
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/avatar`, {
      cache: "no-store",
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout
        ? AbortSignal.timeout(6000)
        : undefined,
    });
    if (res.ok) {
      const blob = await res.blob();
      if (blob && blob.size) {
        out = await new Promise((resolve) => {
          const fr = new FileReader();
          fr.onload = () => resolve(typeof fr.result === "string" ? fr.result : null);
          fr.onerror = () => resolve(null);
          fr.readAsDataURL(blob);
        });
      }
    }
  } catch (_) {
    out = null;
  }
  hostAvatarCache.set(agentId, out);
  return out;
}

async function fillHostAvatars() {
  await Promise.all(
    state.agents.map(async (a) => {
      const host = await fetchHostAvatar(a.id);
      if (host) a.avatar = host;
    })
  );
}

/* ---------------- 头像导入（换机器后补图） ---------------- */

// 宿主的 agents 目录在 App 的 fs 白名单外，换一台机器就必然没有图。
// 这里让用户选一次本机的 .hanako（或 .hanako/agents）目录，
// 把 <角色id>/avatars/agent.png 缩到 128×128 存进 App 自己的数据目录，之后就都有。

const AVATAR_SIDE = 128;

function fileToSquarePng(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth || AVATAR_SIDE;
        const h = img.naturalHeight || AVATAR_SIDE;
        const side = Math.max(1, Math.min(w, h));
        const sx = Math.max(0, Math.floor((w - side) / 2));
        const sy = Math.max(0, Math.floor((h - side) / 2));
        const canvas = document.createElement("canvas");
        canvas.width = AVATAR_SIDE;
        canvas.height = AVATAR_SIDE;
        const g = canvas.getContext("2d");
        g.imageSmoothingQuality = "high";
        g.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIDE, AVATAR_SIDE);
        resolve(canvas.toDataURL("image/png"));
      } catch (err) {
        reject(err);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("这张图读不开"));
    };
    img.src = url;
  });
}

// 认得 .hanako/agents/<id>/avatars/agent.png，也认得直接选中 agents 目录的情况
function parseAvatarPath(relPath) {
  const rel = String(relPath || "").replace(/\\/g, "/");
  const hit = /(?:^|\/)([^/]+)\/avatars\/([^/]+)\.(png|jpe?g|webp)$/i.exec(rel);
  if (!hit) return null;
  return { id: hit[1], primary: /^agent\./i.test(hit[2]) };
}

async function importAvatarsFromFiles(files) {
  const picks = new Map();
  for (const file of files) {
    const hit = parseAvatarPath(file.webkitRelativePath || file.name);
    if (!hit) continue;
    if (!state.agents.some((a) => a.id === hit.id)) continue;
    const prev = picks.get(hit.id);
    if (!prev || (hit.primary && !prev.primary)) picks.set(hit.id, { file, primary: hit.primary });
  }

  if (!picks.size) {
    toast("没在选中的目录里认出「角色id/avatars/agent.png」", "error");
    return;
  }

  let done = 0;
  const failed = [];
  for (const [id, pick] of picks) {
    try {
      const dataUrl = await fileToSquarePng(pick.file);
      const res = await postJson(`/avatars/${encodeURIComponent(id)}`, { dataUrl });
      const agent = state.agents.find((a) => a.id === id);
      if (agent && res && res.avatar) agent.avatar = res.avatar;
      done += 1;
    } catch (err) {
      failed.push(`${id}: ${(err && err.message) || err}`);
    }
  }

  renderModels();
  if (failed.length) toast(`导入 ${done} 张，${failed.length} 张失败：${failed[0]}`, "error");
  else toast(`已导入 ${done} 张头像，存进本机缓存`);
}

async function loadAll() {
  const specs = [
    ["agents", "/agents"],
    ["models", "/models"],
    ["presets", "/presets"],
    ["vault", "/vault"],
  ];
  const settled = await Promise.allSettled(specs.map(([, path]) => api(path)));
  const errors = [];
  settled.forEach((outcome, i) => {
    const key = specs[i][0];
    if (outcome.status === "rejected") {
      errors.push(`${key}: ${(outcome.reason && outcome.reason.message) || outcome.reason}`);
      return;
    }
    const value = outcome.value || {};
    if (key === "agents") state.agents = value.agents || [];
    if (key === "models") state.providers = value.providers || [];
    if (key === "presets") state.presets = value.presets || [];
    if (key === "vault") state.vault = value.providers || [];
  });
  state.loadErrors = errors;
  await fillHostAvatars();
  return errors;
}

async function ensurePreset() {
  if (state.presets.length) return;
  const assignments = {};
  for (const agent of state.agents) if (agent.currentModel) assignments[agent.id] = agent.currentModel;
  const res = await postJson("/presets", { name: "默认配装", assignments });
  state.presets = [res.preset];
}

function selectPreset(id) {
  state.currentPresetId = id || (state.presets[0] ? state.presets[0].id : null);
  const preset = currentPreset();
  state.draft = draftFromAssignments(preset ? preset.assignments : null);
  renderModels();
}

async function saveCurrentPreset() {
  const preset = currentPreset();
  if (!preset) return;
  const name = document.getElementById("pj-name").value.trim() || preset.name;
  const res = await postJson(`/presets/${encodeURIComponent(preset.id)}`, { name, assignments: assignmentsFromDraft() }, "PUT");
  const index = state.presets.findIndex((p) => p.id === preset.id);
  if (index >= 0) state.presets[index] = res.preset;
  renderModels();
}

async function handleApply() {
  const targets = dirtyAgents();
  if (!targets.length) return;
  const lines = targets.map((a) => {
    const from = a.currentModel ? a.currentModel.id : "（未设置）";
    return `${a.name || a.id}：${from} → ${state.draft[a.id].id}`;
  });
  const yes = await confirmDialog(
    `将修改 ${targets.length} 张角色卡的默认模型`,
    `${lines.join("\n")}\n\n改的是它们下次新会话所用的模型，进行中的会话不受影响。`,
    "写入配置"
  );
  if (!yes) return;

  const applyBtn = document.getElementById("pj-apply");
  applyBtn.disabled = true;
  try {
    const res = await postJson("/apply", { assignments: assignmentsFromDraft() });
    await saveCurrentPreset();
    const agents = await api("/agents");
    state.agents = agents.agents || [];
    const preset = currentPreset();
    state.draft = draftFromAssignments(preset ? preset.assignments : null);
    renderModels();
    if (res.failedCount) {
      const detail = (res.results || []).filter((r) => !r.ok).map((r) => r.error).join("；");
      toast(`已写入 ${res.appliedCount} 个，${res.failedCount} 个失败：${detail}`, "error");
    } else {
      toast(`已写入 ${res.appliedCount} 张角色卡的默认模型`);
    }
  } catch (err) {
    toast(String(err.message || err), "error");
    renderCaption();
  }
}

async function handleNew() {
  const res = await postJson("/presets", { name: `配装 ${state.presets.length + 1}`, assignments: {} });
  state.presets.push(res.preset);
  selectPreset(res.preset.id);
  const input = document.getElementById("pj-name");
  input.focus();
  input.select();
}

async function handleDuplicate() {
  const preset = currentPreset();
  const res = await postJson("/presets", {
    name: preset ? `${preset.name} 副本` : "未命名配装",
    assignments: assignmentsFromDraft(),
  });
  state.presets.push(res.preset);
  selectPreset(res.preset.id);
  toast("已复制为新配装");
}

async function handleDelete() {
  const preset = currentPreset();
  if (!preset) return;
  const yes = await confirmDialog("删除配装", `确定删除「${preset.name}」？只删这套记录，不改动任何角色卡。`, "删除");
  if (!yes) return;
  await api(`/presets/${encodeURIComponent(preset.id)}`, { method: "DELETE" });
  state.presets = state.presets.filter((p) => p.id !== preset.id);
  selectPreset(state.presets[0] ? state.presets[0].id : null);
  toast("配装已删除");
}

async function handleImport() {
  for (const agent of state.agents) {
    state.draft[agent.id] = agent.currentModel ? { ...agent.currentModel } : null;
  }
  renderModels();
  await saveCurrentPreset();
  toast("已把实况写进当前配装");
}

function bind() {
  document.querySelectorAll(".pj-tabs button").forEach((b) =>
    b.addEventListener("click", () => setView(b.dataset.tab))
  );
  document.getElementById("pj-preset").addEventListener("change", (e) => selectPreset(e.target.value));
  document.getElementById("pj-name").addEventListener("change", () => {
    saveCurrentPreset().catch((err) => toast(String(err.message || err), "error"));
  });
  document.getElementById("pj-new").addEventListener("click", () => handleNew().catch((e) => toast(String(e.message || e), "error")));
  document.getElementById("pj-dup").addEventListener("click", () => handleDuplicate().catch((e) => toast(String(e.message || e), "error")));
  document.getElementById("pj-del").addEventListener("click", () => handleDelete().catch((e) => toast(String(e.message || e), "error")));
  document.getElementById("pj-import").addEventListener("click", () => handleImport().catch((e) => toast(String(e.message || e), "error")));
  document.getElementById("pj-apply").addEventListener("click", () => handleApply().catch((e) => toast(String(e.message || e), "error")));
  document.getElementById("pj-reload").addEventListener("click", async () => {
    try {
      await loadAll();
      selectPreset(state.currentPresetId);
      renderVault();
      toast("已刷新");
    } catch (err) {
      toast(String(err.message || err), "error");
    }
  });
  document.getElementById("pj-refresh-mount").addEventListener("click", async () => {
    try {
      const vault = await api("/vault");
      state.vault = vault.providers || [];
      renderVault();
      renderModels();
      toast("已刷新挂载状态");
    } catch (err) {
      toast(String(err.message || err), "error");
    }
  });

  const avatarBtn = document.getElementById("pj-avatar");
  const avatarInput = document.getElementById("pj-avatar-input");
  if (avatarBtn && avatarInput) {
    avatarBtn.addEventListener("click", () => avatarInput.click());
    avatarInput.addEventListener("change", async () => {
      const files = Array.from(avatarInput.files || []);
      avatarInput.value = "";
      if (!files.length) return;
      try {
        await importAvatarsFromFiles(files);
      } catch (err) {
        toast(String((err && err.message) || err), "error");
      }
    });
  }
}

/* ---------------- 入口 ---------------- */

export async function boot() {
  await getHana();
  bind();
  document.getElementById("pj-sub").textContent = "正在读取角色卡与供应商…";

  const errors = await loadAll();
  if (errors.length) {
    console.error("[配装] 启动读取异常：", errors);
    toast(errors[0], "error");
  }

  try {
    await ensurePreset();
  } catch (err) {
    console.error("[配装] 建默认配装失败：", err);
    const message = String((err && err.message) || err);
    if (!state.loadErrors.length) state.loadErrors = [`presets: ${message}`];
  }

  selectPreset(state.currentPresetId || (state.presets[0] ? state.presets[0].id : null));
  renderVault();
  renderModels();
}
