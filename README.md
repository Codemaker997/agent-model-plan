# 配装

Hana **v2 App**。两件事：

1. **模型配装** —— 把每个角色卡的默认聊天模型存成一套「配装」，一键写回宿主。原来的 `agent-model-presets`（v1 插件）由它接替。
2. **钥匙串** —— 集中存放各供应商的多套 API Key，需要切换时复制出来，贴进 Hana 设置即可。

整页卡带 `siteNavEntry`，常驻侧边栏。

## 界面

两个视图，右上角切换。

- **模型配装**：一屏列出全部角色卡，对照「实况模型」与「配装模型」。供应商用品牌图标加名称前置，扫一眼就知道牌子从哪家换到哪家。
- **钥匙串**：左右分栏。左栏是供应商导航，绿点表示这家**当前在宿主里已挂载**，末尾数字是本机存了几套；右栏是该供应商的详情，头部显示 `当前挂载 ····a3f9`（只读指纹，末四位取自宿主真实凭据），下面密钥逐行排列，区域固定高度、超出滚动。

配色不写死，全部走 Hana 注入的主题变量（`--bg` / `--accent` / `--text` …），浅色 `warm-paper` 与深色 `midnight-contrast` 自动跟随。

设计过程的静态稿留在 `design/mockup.html`，可单独打开预览。

## 权限

安装时确认五项：

| 能力 | 用途 |
|---|---|
| `app/agents.read` | 读所有角色卡的配置 |
| `app/agents.manage` | 写回所有角色卡的默认模型 |
| `app/models.read` | 读可用模型目录与供应商列表 |
| `app/provider.credentials.read` | 读宿主当前挂载凭据的末四位（指纹回读） |
| `app/ui.clipboard-write` | 把密钥写进剪贴板 |

缺哪项，对应动作会在界面上直接说缺哪项。

## 密钥怎么存

- 落盘位置：`{HANA_HOME}/app-data/agent-model-plan/vault.json`
- 加密：AES-256-GCM，主密钥是首次运行生成的 32 字节随机值，存在同目录的 `vault.key`
- 明文只在「复制」那一刻经后端解出，走本机回环交给页面写剪贴板，不落任何日志

**安全边界要说清楚**：主密钥和被加密的密文在同一台机器上，它挡的是「这份文件被单独拷走」，挡不住能读你整台机器的人。想要更硬的，可以改成口令派生（PBKDF2），结构上留了口子。

## 为什么不能直接改宿主里的密钥

v2 没有「写宿主 provider 凭据」的动词：`provider:credentials` 只能读，`model:list` 明确不含 apiKey，App 也写不了 `HANA_HOME`。所以**最后一步必须你手动完成**：

1. 在钥匙串里点「复制」
2. 进 `设置 → 模型 → 供应商`，粘贴保存
3. 回配装点「刷新挂载状态」，上面那行末四位会变成新挂上的那一套

## 配装数据

存在 `{HANA_HOME}/app-data/agent-model-plan/presets.json`，卸载 App 不会删。结构：

```json
[
  {
    "id": "xxx",
    "name": "默认配装",
    "assignments": { "<agentId>": { "id": "<modelId>", "provider": "<providerId>" } },
    "createdAt": "…",
    "updatedAt": "…"
  }
]
```

## 目录

```text
agent-model-plan/
├── manifest.json
├── index.js                    # apply(ctx)：ctx.routes.register 挂后端
├── assets/icon.svg             # 身份图标（包根）
├── design/mockup.html          # 静态设计稿
└── ui/
    ├── index.html              # 整页卡
    ├── app.mjs                 # 前端逻辑
    ├── style.css
    ├── assets/
    │   ├── cover.webp          # 卡片封面
    │   └── providers/*.svg     # 供应商品牌图标（缺谁就回落到色块 + 首字）
    └── sdk/ui.js               # 随包分发的浏览器 SDK
```

## 开发

```bash
node <hana>/skills/hana-app-creator/scripts/validate_app.mjs --dir . --json
node <hana>/skills/hana-app-creator/scripts/validate_app.mjs --dir . --smoke --json
```

本地目录安装的 App 是**复制**到 `apps/` 的，运行实例不会回头读源码，也没有 update 通道。改完要「卸载 → 重新安装 → 确认」，配装数据在 `app-data` 里，不受影响。
