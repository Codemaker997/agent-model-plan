// 配装（v2 App 后端）
//
// 两件事：
//   一、模型配装 —— 读所有角色卡的默认聊天模型、列出可用模型、维护命名配装、把配装写回宿主。
//   二、钥匙串   —— 集中存放各供应商的多套 API Key（本机主密钥加密后落盘），并回读宿主当前挂载指纹。
//
// 宿主公开动词：
//   agent:list / agent:config / agent:update-config   跨归属分区需要 scope: "all"
//   provider:models-by-type                            chat 模型目录
//   provider:credentials                               读取某供应商当前挂载的凭据（需授权）
//
// 能力：app/agents.read、app/agents.manage、app/models.read、
//       app/provider.credentials.read、app/ui.clipboard-write

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const APP_ID = "agent-model-plan";

const SCOPE_ALL = "all";
const VAULT_VERSION = 1;

function fail(c, code, message, status = 500) {
  return c.json({ ok: false, error: { code, message } }, status);
}

function normalizeChat(chat) {
  if (!chat) return null;
  if (typeof chat === "object") {
    const id = chat.id ?? chat.model ?? chat.modelId ?? "";
    if (!id) return null;
    return { id: String(id), provider: String(chat.provider ?? "") };
  }
  return { id: String(chat), provider: "" };
}

export function apply(ctx) {
  const log = (level, ...args) => {
    try {
      ctx?.logger?.[level]?.(`[${APP_ID}]`, ...args);
    } catch (_) {
      /* 日志失败不影响业务 */
    }
  };

  if (!ctx || typeof ctx.routes?.register !== "function") {
    log("error", "ctx.routes.register 不可用：宿主版本低于 0.978.0");
    return () => {};
  }

  /* ---------------- 数据目录 ---------------- */

  const dataDir = typeof ctx.dataDir === "string" && ctx.dataDir ? ctx.dataDir : null;
  if (dataDir) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
    } catch (err) {
      log("warn", `dataDir 不可用：${err?.message || err}`);
    }
  }

  const presetsFile = dataDir ? path.join(dataDir, "presets.json") : null;
  const vaultFile = dataDir ? path.join(dataDir, "vault.json") : null;
  const vaultKeyFile = dataDir ? path.join(dataDir, "vault.key") : null;

  /* ---------------- 角色卡头像 ---------------- */

  // dataDir = {HANA_HOME}/app-data/{appId}，上两级就是 HANA_HOME
  const hanaHome = dataDir ? path.dirname(path.dirname(dataDir)) : null;

  const AVATAR_CANDIDATES = [
    "avatars/agent.png",
    "avatars/agent.webp",
    "avatars/agent.jpg",
    "avatars/agent.jpeg",
    "avatar.png",
    "avatar.webp",
  ];

  // App 自己的安装目录：随包头像读这里不受 HANA_HOME 权限限制
  const APP_DIR = path.dirname(fileURLToPath(import.meta.url));

  // 头像缓存：宿主目录 app 后端读不进来（allow-fs-read 只给 installDir/dataDir），
  // 所以换一台机器后由用户就地导入一次，图片落在这里，之后每次都能读到。
  const avatarCacheDir = dataDir ? path.join(dataDir, "avatars") : null;
  const YUAN_AVATAR_DIR = path.join(APP_DIR, "avatars-yuan");
  const YUAN_KEYS = new Set(["hanako", "butter", "ming", "kong"]);
  const AVATAR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  const AVATAR_MAX_BYTES = 512 * 1024;

  function safeAvatarId(raw) {
    const id = String(raw || "").trim();
    return AVATAR_ID_RE.test(id) && !id.includes("..") ? id : null;
  }

  function readCachedAvatar(agentId) {
    if (!avatarCacheDir) return null;
    try {
      const file = path.join(avatarCacheDir, `${agentId}.png`);
      if (!fs.existsSync(file)) return null;
      const buf = fs.readFileSync(file);
      return buf.length ? dataUrlOf(buf, file) : null;
    } catch (_) {
      return null;
    }
  }

  function readBundledAvatar(agentId) {
    try {
      const file = path.join(APP_DIR, "avatars", `${agentId}.png`);
      if (!fs.existsSync(file)) return null;
      const buf = fs.readFileSync(file);
      return buf.length ? dataUrlOf(buf, file) : null;
    } catch (_) {
      return null;
    }
  }

  // 四神兽（yuan）的兜底头像：新角色没有自己的图时，按它的人格底座给一张
  function readYuanAvatar(yuan) {
    const key = String(yuan || "").trim().toLowerCase();
    if (!YUAN_KEYS.has(key)) return null;
    try {
      const file = path.join(YUAN_AVATAR_DIR, `${key}.png`);
      if (!fs.existsSync(file)) return null;
      const buf = fs.readFileSync(file);
      return buf.length ? dataUrlOf(buf, file) : null;
    } catch (_) {
      return null;
    }
  }

  // ctx.resources.read 的回包形状在类型里是不透明的，这里宽松地取字节
  function bufferOf(result) {
    if (!result) return null;
    if (Buffer.isBuffer(result)) return result;
    if (typeof result === "string") return Buffer.from(result, "base64");
    const inner = result.data !== undefined ? result.data : result.content;
    if (Buffer.isBuffer(inner)) return inner;
    if (typeof inner === "string") return Buffer.from(inner, "base64");
    if (Array.isArray(inner)) return Buffer.from(inner);
    return null;
  }

  function dataUrlOf(buf, rel) {
    const ext = path.extname(rel).toLowerCase();
    const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    return `data:${mime};base64,${buf.toString("base64")}`;
  }

  // 头像读法见 docs/avatar-access.md：宿主白名单不给图片，只能随包携带
  const AGENT_REF_SHAPES = [
    { name: "name=id", make: (id, nm, rel) => ({ kind: "agent", name: id, path: rel }) },
    { name: "name=显示名", make: (id, nm, rel) => ({ kind: "agent", name: nm, path: rel }) },
    { name: "name=id+agentId", make: (id, nm, rel) => ({ kind: "agent", name: id, agentId: id, path: rel }) },
    { name: "name=显示名+agentId", make: (id, nm, rel) => ({ kind: "agent", name: nm, agentId: id, path: rel }) },
  ];

  async function readAgentAvatar(agentId, yuan) {
    const cached = readCachedAvatar(agentId);
    if (cached) return { data: cached, diag: "本机缓存" };
    const bundled = readBundledAvatar(agentId);
    if (bundled) return { data: bundled, diag: "随包" };
    const fallback = readYuanAvatar(yuan);
    if (fallback) return { data: fallback, diag: `yuan:${yuan}` };
    return { data: null, diag: "缺图" };
  }

  // [保留备查] 旧探测逻辑：四条路全被权限模型拦死，详见 docs/avatar-access.md
  async function readAgentAvatarLegacy(agentId, agentName) {
    const diag = [];

    // 二、宿主 agent 资源（白名单只放 md 文档，留着以防将来放开）
    for (const shape of AGENT_REF_SHAPES) {
      for (const rel of AVATAR_CANDIDATES) {
        try {
          const got = await ctx.resources.read(shape.make(agentId, agentName, rel));
          const buf = bufferOf(got);
          if (buf && buf.length) return { data: dataUrlOf(buf, rel), diag: `${shape.name}+${rel} 成功` };
          if (diag.length < 4) {
            const shapeKeys = got && typeof got === "object" ? Object.keys(got).join("|") : String(got);
            diag.push(`${shape.name}: 空回包(${shapeKeys})`);
          }
        } catch (err) {
          if (diag.length < 4) {
            // 第一条留完整白名单，其余只留头部，避免页面被刷屏
            const msg = (err && err.message) || String(err);
            diag.push(`${shape.name}: ${diag.length === 0 ? msg.slice(0, 700) : msg.slice(0, 60)}`);
          }
        }
        break; // 每种形状只试第一个路径，够了
      }
    }

    // 二、兜底：直接读 HANA_HOME（大概率被 Node 权限拦）
    if (hanaHome) {
      try {
        const file = path.join(hanaHome, "agents", agentId, "avatars", "agent.png");
        if (fs.existsSync(file)) {
          const buf = fs.readFileSync(file);
          if (buf.length) return { data: dataUrlOf(buf, "avatars/agent.png"), diag: "fs 成功" };
          diag.push("fs: 文件为空");
        } else {
          diag.push(`fs: 不存在 ${file}`.slice(0, 90));
        }
      } catch (err) {
        diag.push(`fs: ${(err && err.message) || err}`.slice(0, 90));
      }
    }

    // 最后一手：agent:profile 里可能自带头像类字段
    try {
      const prof = await ctx.bus.request("agent:profile", { agentId });
      const keys = prof && typeof prof === "object" ? Object.keys(prof).join("|") : String(prof);
      diag.push(`profile 键: ${keys}`.slice(0, 300));
    } catch (err) {
      diag.push(`profile: ${(err && err.message) || err}`.slice(0, 120));
    }

    return { data: null, diag: diag.join(" ｜ ") };
  }

  /* ---------------- 配装（方案） ---------------- */

  function readPresets() {
    if (!presetsFile || !fs.existsSync(presetsFile)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(presetsFile, "utf-8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      log("warn", `读取配装失败：${err?.message || err}`);
      return [];
    }
  }

  function writePresets(list) {
    if (!presetsFile) throw new Error("数据目录不可用，无法保存配装");
    fs.writeFileSync(presetsFile, JSON.stringify(list, null, 2), "utf-8");
  }

  function newId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /* ---------------- 钥匙串：本机主密钥 ---------------- */

  let cachedKey = null;

  function masterKey() {
    if (cachedKey) return cachedKey;
    if (!vaultKeyFile) throw new Error("数据目录不可用，无法访问钥匙串");
    if (fs.existsSync(vaultKeyFile)) {
      const hex = fs.readFileSync(vaultKeyFile, "utf-8").trim();
      if (hex.length === 64) {
        cachedKey = Buffer.from(hex, "hex");
        return cachedKey;
      }
      log("warn", "主密钥文件格式异常，重新生成");
    }
    const key = crypto.randomBytes(32);
    fs.writeFileSync(vaultKeyFile, key.toString("hex"), { encoding: "utf-8", mode: 0o600 });
    cachedKey = key;
    return key;
  }

  function sealSecret(plain) {
    const key = masterKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(String(plain), "utf-8"), cipher.final()]);
    return {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: body.toString("base64"),
    };
  }

  function openSecret(box) {
    if (!box || !box.iv || !box.tag || !box.data) throw new Error("密钥记录已损坏");
    const key = masterKey();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
    decipher.setAuthTag(Buffer.from(box.tag, "base64"));
    const out = Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]);
    return out.toString("utf-8");
  }

  function readVault() {
    if (!vaultFile || !fs.existsSync(vaultFile)) return { version: VAULT_VERSION, entries: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(vaultFile, "utf-8"));
      if (!parsed || typeof parsed !== "object" || typeof parsed.entries !== "object" || !parsed.entries) {
        return { version: VAULT_VERSION, entries: {} };
      }
      return { version: VAULT_VERSION, entries: parsed.entries };
    } catch (err) {
      log("warn", `读取钥匙串失败：${err?.message || err}`);
      return { version: VAULT_VERSION, entries: {} };
    }
  }

  function writeVault(vault) {
    if (!vaultFile) throw new Error("数据目录不可用，无法保存钥匙串");
    fs.writeFileSync(vaultFile, JSON.stringify(vault, null, 2), "utf-8");
  }

  function tailOf(plain) {
    const s = String(plain || "");
    return s.length >= 4 ? s.slice(-4) : s;
  }

  /** 对外投影：绝不返回明文密钥。 */
  function projectEntry(entry) {
    let tail = "";
    let length = 0;
    let broken = false;
    try {
      const plain = openSecret(entry.secret);
      tail = tailOf(plain);
      length = plain.length;
    } catch (_) {
      broken = true;
    }
    return {
      id: entry.id,
      label: entry.label,
      note: entry.note || "",
      tail,
      length,
      broken,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }

  /* ---------------- 总线小工具 ---------------- */

  async function bus(method, payload) {
    return ctx.bus.request(method, payload);
  }

  function describeError(err) {
    const message = err?.message || String(err);
    const code = err?.code || err?.kind || "BUS_ERROR";
    if (/capab|permission|denied|grant|授权|权限/i.test(`${code} ${message}`)) {
      return {
        code: "CAPABILITY_REQUIRED",
        message: `${message}。请在「设置 → 应用 → 应用权限」里为配装打开对应开关。`,
      };
    }
    return { code, message };
  }

  /* ---------------- 路由 ---------------- */

  ctx.routes.register((app) => {
    app.get("/health", (c) =>
      c.json({ ok: true, appId: APP_ID, version: VAULT_VERSION, dataDir: Boolean(dataDir) })
    );

    /* ---- 角色卡 ---- */

    app.get("/agents", async (c) => {
      try {
        const listed = await bus("agent:list", { scope: SCOPE_ALL, lifecycle: "active" });
        const rows = Array.isArray(listed?.agents) ? listed.agents : [];
        const agents = await Promise.all(
          rows.map(async (agent) => {
            let currentModel = null;
            let readError = null;
            try {
              const cfg = await bus("agent:config", { agentId: agent.id, scope: SCOPE_ALL });
              currentModel = normalizeChat(cfg?.config?.models?.chat);
            } catch (err) {
              readError = describeError(err).message;
            }
            const avatar = await readAgentAvatar(agent.id, agent.yuan);
            return {
              id: agent.id,
              name: agent.name || agent.id,
              yuan: agent.yuan || "",
              isPrimary: !!agent.isPrimary,
              isCurrent: !!agent.isCurrent,
              currentModel,
              readError,
              avatar: avatar.data,
              avatarDiag: avatar.diag,
            };
          })
        );
        return c.json({ ok: true, agents });
      } catch (err) {
        const info = describeError(err);
        log("error", `GET /agents 失败：${info.message}`);
        return fail(c, info.code, info.message, info.code === "CAPABILITY_REQUIRED" ? 403 : 503);
      }
    });

    /* ---- 头像缓存 ---- */

    // 本机已经导入过哪几张头像
    app.get("/avatars", (c) => {
      if (!avatarCacheDir) return c.json({ ok: true, ids: [] });
      try {
        const ids = fs
          .readdirSync(avatarCacheDir)
          .filter((name) => name.endsWith(".png"))
          .map((name) => name.slice(0, -4))
          .filter((id) => AVATAR_ID_RE.test(id));
        return c.json({ ok: true, ids });
      } catch (err) {
        return c.json({ ok: true, ids: [], reason: err?.message || String(err) });
      }
    });

    // 收一张已裁好的 PNG（前端用 canvas 统一成 128×128），写进本机缓存
    app.post("/avatars/:id", async (c) => {
      const id = safeAvatarId(c.req.param("id"));
      if (!id) return fail(c, "INVALID_AGENT_ID", "角色 id 不合法", 400);
      if (!avatarCacheDir) return fail(c, "DATA_DIR_UNAVAILABLE", "数据目录不可用，无法保存头像", 500);
      try {
        const body = await c.req.json().catch(() => ({}));
        const raw = typeof body?.dataUrl === "string" ? body.dataUrl : "";
        const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(raw);
        if (!match) return fail(c, "INVALID_PAYLOAD", "dataUrl 必须是 PNG 的 base64", 400);
        const buf = Buffer.from(match[1], "base64");
        if (!buf.length) return fail(c, "INVALID_PAYLOAD", "图片内容为空", 400);
        if (buf.length > AVATAR_MAX_BYTES) {
          return fail(c, "AVATAR_TOO_LARGE", `图片超过 ${Math.round(AVATAR_MAX_BYTES / 1024)} KB`, 413);
        }
        fs.mkdirSync(avatarCacheDir, { recursive: true });
        fs.writeFileSync(path.join(avatarCacheDir, `${id}.png`), buf);
        return c.json({ ok: true, id, bytes: buf.length, avatar: readCachedAvatar(id) });
      } catch (err) {
        return fail(c, "AVATAR_WRITE_FAILED", err?.message || String(err));
      }
    });

    app.delete("/avatars/:id", (c) => {
      const id = safeAvatarId(c.req.param("id"));
      if (!id) return fail(c, "INVALID_AGENT_ID", "角色 id 不合法", 400);
      try {
        const file = avatarCacheDir ? path.join(avatarCacheDir, `${id}.png`) : null;
        if (file && fs.existsSync(file)) fs.rmSync(file, { force: true });
        return c.json({ ok: true });
      } catch (err) {
        return fail(c, "AVATAR_DELETE_FAILED", err?.message || String(err));
      }
    });

    /* ---- 模型目录 ---- */

    app.get("/models", async (c) => {
      try {
        const res = await bus("provider:models-by-type", { type: "chat" });
        const models = Array.isArray(res?.models) ? res.models : [];
        const byProvider = new Map();
        for (const m of models) {
          const provider = m.provider || "unknown";
          if (!byProvider.has(provider)) {
            byProvider.set(provider, {
              provider,
              displayName: m.providerDisplayName || m.provider || provider,
              models: [],
            });
          }
          byProvider.get(provider).models.push({
            id: m.id,
            provider,
            displayName: m.displayName || m.name || m.id,
          });
        }
        return c.json({ ok: true, providers: [...byProvider.values()] });
      } catch (err) {
        const info = describeError(err);
        log("error", `GET /models 失败：${info.message}`);
        return fail(c, info.code, info.message, info.code === "CAPABILITY_REQUIRED" ? 403 : 503);
      }
    });

    /* ---- 配装 CRUD ---- */

    app.get("/presets", (c) => {
      try {
        return c.json({ ok: true, presets: readPresets() });
      } catch (err) {
        return fail(c, "PRESETS_READ_FAILED", err?.message || String(err));
      }
    });

    app.post("/presets", async (c) => {
      try {
        const body = await c.req.json().catch(() => ({}));
        const list = readPresets();
        const now = new Date().toISOString();
        const preset = {
          id: newId(),
          name: typeof body?.name === "string" && body.name.trim() ? body.name.trim() : "未命名配装",
          assignments: body?.assignments && typeof body.assignments === "object" ? body.assignments : {},
          createdAt: now,
          updatedAt: now,
        };
        list.push(preset);
        writePresets(list);
        return c.json({ ok: true, preset });
      } catch (err) {
        return fail(c, "PRESET_CREATE_FAILED", err?.message || String(err));
      }
    });

    app.put("/presets/:id", async (c) => {
      try {
        const id = c.req.param("id");
        const body = await c.req.json().catch(() => ({}));
        const list = readPresets();
        const index = list.findIndex((p) => p.id === id);
        if (index === -1) return fail(c, "PRESET_NOT_FOUND", "配装不存在", 404);
        const current = list[index];
        list[index] = {
          ...current,
          name: typeof body?.name === "string" && body.name.trim() ? body.name.trim() : current.name,
          assignments:
            body?.assignments && typeof body.assignments === "object" ? body.assignments : current.assignments,
          updatedAt: new Date().toISOString(),
        };
        writePresets(list);
        return c.json({ ok: true, preset: list[index] });
      } catch (err) {
        return fail(c, "PRESET_UPDATE_FAILED", err?.message || String(err));
      }
    });

    app.delete("/presets/:id", (c) => {
      try {
        const id = c.req.param("id");
        const list = readPresets();
        if (!list.some((p) => p.id === id)) return fail(c, "PRESET_NOT_FOUND", "配装不存在", 404);
        writePresets(list.filter((p) => p.id !== id));
        return c.json({ ok: true });
      } catch (err) {
        return fail(c, "PRESET_DELETE_FAILED", err?.message || String(err));
      }
    });

    app.post("/apply", async (c) => {
      try {
        const body = await c.req.json().catch(() => ({}));
        const assignments = body?.assignments;
        if (!assignments || typeof assignments !== "object") {
          return fail(c, "INVALID_PAYLOAD", "assignments 必填且必须是对象", 400);
        }

        const results = [];
        for (const [agentId, model] of Object.entries(assignments)) {
          if (!model || !model.id || !model.provider) {
            results.push({ agentId, ok: false, error: "模型信息不完整（需要 id 与 provider）" });
            continue;
          }
          try {
            await bus("agent:update-config", {
              agentId,
              scope: SCOPE_ALL,
              partial: { models: { chat: { id: model.id, provider: model.provider } } },
            });
            results.push({ agentId, ok: true });
          } catch (err) {
            results.push({ agentId, ok: false, error: describeError(err).message });
          }
        }

        const failedCount = results.filter((r) => !r.ok).length;
        return c.json({ ok: failedCount === 0, results, failedCount, appliedCount: results.length - failedCount });
      } catch (err) {
        const info = describeError(err);
        log("error", `POST /apply 失败：${info.message}`);
        return fail(c, info.code, info.message);
      }
    });

    /* ---- 钥匙串 ---- */

    // 读宿主当前挂载的凭据指纹。只回末四位与长度，绝不回明文。
    async function mountStatus(providerId) {
      try {
        const res = await bus("provider:credentials", { providerId });
        const key = typeof res?.apiKey === "string" ? res.apiKey : "";
        const headers = res?.headers && typeof res.headers === "object" ? Object.keys(res.headers).length : 0;
        if (key) return { mounted: true, tail: tailOf(key), length: key.length, via: "apiKey" };
        if (headers > 0) return { mounted: true, tail: "", length: 0, via: "headers" };
        return { mounted: false, tail: "", length: 0, via: "empty" };
      } catch (err) {
        const info = describeError(err);
        return {
          mounted: false,
          tail: "",
          length: 0,
          via: "error",
          error: info.code === "CAPABILITY_REQUIRED" ? "未授权读取凭据" : info.message,
        };
      }
    }

    // 供应商目录 + 挂载指纹 + 本机存了哪几套
    app.get("/vault", async (c) => {
      try {
        let providers = [];
        try {
          const res = await bus("provider:models-by-type", { type: "chat" });
          const models = Array.isArray(res?.models) ? res.models : [];
          const seen = new Map();
          for (const m of models) {
            const id = m.provider || "unknown";
            if (!seen.has(id)) seen.set(id, m.providerDisplayName || m.provider || id);
          }
          providers = [...seen.entries()].map(([id, displayName]) => ({ id, displayName }));
        } catch (err) {
          log("warn", `拉取供应商目录失败：${err?.message || err}`);
        }

        const vault = readVault();

        // 目录里没有、但本机存过密钥的供应商也要出现
        for (const id of Object.keys(vault.entries)) {
          if (!providers.some((p) => p.id === id)) providers.push({ id, displayName: id });
        }

        const withStatus = await Promise.all(
          providers.map(async (p) => {
            const entries = Array.isArray(vault.entries[p.id]) ? vault.entries[p.id] : [];
            return {
              id: p.id,
              displayName: p.displayName,
              mount: await mountStatus(p.id),
              entries: entries.map(projectEntry),
            };
          })
        );

        return c.json({ ok: true, providers: withStatus });
      } catch (err) {
        const info = describeError(err);
        log("error", `GET /vault 失败：${info.message}`);
        return fail(c, info.code, info.message);
      }
    });

    app.post("/vault/entries", async (c) => {
      try {
        const body = await c.req.json().catch(() => ({}));
        const providerId = String(body?.providerId || "").trim();
        const secret = String(body?.secret || "").trim();
        if (!providerId) return fail(c, "INVALID_PAYLOAD", "providerId 必填", 400);
        if (!secret) return fail(c, "INVALID_PAYLOAD", "密钥不能为空", 400);

        const vault = readVault();
        const list = Array.isArray(vault.entries[providerId]) ? vault.entries[providerId] : [];
        const now = new Date().toISOString();
        const entry = {
          id: newId(),
          label: String(body?.label || "").trim() || "未命名",
          note: String(body?.note || "").trim(),
          secret: sealSecret(secret),
          createdAt: now,
          updatedAt: now,
        };
        list.push(entry);
        vault.entries[providerId] = list;
        writeVault(vault);
        return c.json({ ok: true, entry: projectEntry(entry) });
      } catch (err) {
        return fail(c, "VAULT_WRITE_FAILED", err?.message || String(err));
      }
    });

    app.put("/vault/entries/:id", async (c) => {
      try {
        const id = c.req.param("id");
        const body = await c.req.json().catch(() => ({}));
        const vault = readVault();

        for (const providerId of Object.keys(vault.entries)) {
          const list = vault.entries[providerId];
          const index = list.findIndex((e) => e.id === id);
          if (index === -1) continue;
          const current = list[index];
          list[index] = {
            ...current,
            label: typeof body?.label === "string" && body.label.trim() ? body.label.trim() : current.label,
            note: typeof body?.note === "string" ? body.note.trim() : current.note,
            secret: typeof body?.secret === "string" && body.secret.trim() ? sealSecret(body.secret.trim()) : current.secret,
            updatedAt: new Date().toISOString(),
          };
          writeVault(vault);
          return c.json({ ok: true, entry: projectEntry(list[index]) });
        }
        return fail(c, "ENTRY_NOT_FOUND", "密钥记录不存在", 404);
      } catch (err) {
        return fail(c, "VAULT_WRITE_FAILED", err?.message || String(err));
      }
    });

    app.delete("/vault/entries/:id", (c) => {
      try {
        const id = c.req.param("id");
        const vault = readVault();
        for (const providerId of Object.keys(vault.entries)) {
          const list = vault.entries[providerId];
          const next = list.filter((e) => e.id !== id);
          if (next.length !== list.length) {
            vault.entries[providerId] = next;
            writeVault(vault);
            return c.json({ ok: true });
          }
        }
        return fail(c, "ENTRY_NOT_FOUND", "密钥记录不存在", 404);
      } catch (err) {
        return fail(c, "VAULT_WRITE_FAILED", err?.message || String(err));
      }
    });

    // 取一次明文，交给页面写剪贴板。明文不出本机回环。
    app.post("/vault/reveal", async (c) => {
      try {
        const body = await c.req.json().catch(() => ({}));
        const id = String(body?.id || "").trim();
        if (!id) return fail(c, "INVALID_PAYLOAD", "id 必填", 400);
        const vault = readVault();
        for (const providerId of Object.keys(vault.entries)) {
          const entry = vault.entries[providerId].find((e) => e.id === id);
          if (!entry) continue;
          try {
            return c.json({ ok: true, secret: openSecret(entry.secret) });
          } catch (err) {
            return fail(c, "SECRET_UNREADABLE", "这条记录解不开，可能已损坏", 409);
          }
        }
        return fail(c, "ENTRY_NOT_FOUND", "密钥记录不存在", 404);
      } catch (err) {
        return fail(c, "VAULT_READ_FAILED", err?.message || String(err));
      }
    });
  });
}
