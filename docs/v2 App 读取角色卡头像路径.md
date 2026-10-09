# v2 App 读取角色卡头像：一次完整的排查记录

写于 2026-10-08。给「配装」App 加头像时走的弯路，留档备查。

## 结论

**v2 App 读不到宿主里的角色头像。** 头像必须随 App 包一起分发，从 App 自己的安装目录读。

原因是权限模型的边界，不是姿势不对。四条路全试过，前三条是设计上关着的门。

## 三条权限铁律

### 一、App 的 fs 只能读三个地方

```
--allow-fs-read=<installDir>      App 自己的安装目录
--allow-fs-read=<dataDir>         App 自己的数据目录
--allow-fs-read=<localeDir>       locale 目录（extraRead 的唯一来源）
--allow-fs-write=<dataDir>        只有 dataDir 可写
```

探到这段的原始代码（`bundle/index.js`，1.0.4-beta）：

```js
const e = [ Sx(t.installDir), Sx(t.dataDir), ...(t.extraRead ?? []).map(s => Sx(s)) ];
const n = ["--permission"];
for (const s of [...new Set(e)]) n.push(`--allow-fs-read=${s}`);
n.push(`--allow-fs-write=${Sx(t.dataDir)}`);
t.allowChildProcess && n.push("--allow-child-process");
```

调用点是 `hYr({ installDir, dataDir, allowChildProcess, extraRead })`，其中

```js
const l = nJr();              // locale 目录
const u = l ? [l] : [];       // extraRead 就是它
```

**所以 `extraRead` 不是 manifest 能声明的字段**，它由宿主内部决定，且只指向 locale。想靠 manifest 申请读 `HANA_HOME/agents` 是不存在的入口。

直读 `HANA_HOME` 的实际报错：

```
fs: Access to this API has been restricted. Use --allow-fs-read to manage permissions.
```

### 二、agent 资源引用的白名单只有三个文件

正确引用形状（错误信息逼出来的）：

```js
ctx.resources.read({ kind: "agent", name: <agentId 或显示名>, path: "avatar.png" })
```

但路径白名单是封闭的，实际报错原文：

```
agent path "avatars/agent.png" is not allowed;
allowed: identity.md, AGENTS.md, AGENTS.public.md
```

**三个 Markdown 文档，没有任何图片。** 这个入口的设计用途是"读角色设定"，不是"取美术资源"。

注意报错文案里的措辞：`agent ResourceRef requires name`。字段名必须叫 **`name`**，传 `agentId` / `id` / `file` / 只给 `path` 都会撞在同一句上。这一点卡了四轮才试出来。

### 三、agent:profile 只对自家 agent 生效

```
profile: agent:profile: agent "hanako" does not belong to app "agent-model-plan"
```

调用它会回键名列表，但归属校验在前，跨 App 读别的 agent 拿不到任何东西。

## 试过的四条路

| # | 路径 | 结果 | 拦在哪 |
|---|---|---|---|
| 1 | 直读 `HANA_HOME/agents/<id>/avatars/agent.png` | 失败 | Node Permission Model |
| 2 | `ctx.resources.read({ kind: "agent", ... })` | 失败 | 路径白名单只放 md |
| 3 | `agent:profile` 找头像字段 | 失败 | 归属校验 |
| 4 | manifest 声明读权限 / `extraRead` | 不存在 | 非 manifest 字段 |

## 可行方案：随包携带

### 步骤

1. **取源**：`HANA_HOME/agents/<agentId>/avatars/agent.png`（并非每个角色都有这个文件，缺的回落首字母）

2. **压缩**：原图 1024×1024 到 2048×2048，单张 2 到 5 MB，全部头像合计三十多 MB，直接进包太重。按**短边居中裁正方形**再缩到 **128×128**，PNG 无损保存，单张约 40 KB，压完只剩几百 KB。

   ```powershell
   Add-Type -AssemblyName System.Drawing
   $img  = [System.Drawing.Image]::FromFile($src)
   $side = [Math]::Min($img.Width, $img.Height)
   $sx   = [int](($img.Width  - $side) / 2)
   $sy   = [int](($img.Height - $side) / 2)
   $bmp  = New-Object System.Drawing.Bitmap(128, 128)
   $g    = [System.Drawing.Graphics]::FromImage($bmp)
   $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
   $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
   $g.DrawImage($img, (New-Object System.Drawing.Rectangle 0,0,128,128),
                      (New-Object System.Drawing.Rectangle $sx,$sy,$side,$side),
                      [System.Drawing.GraphicsUnit]::Pixel)
   ```

3. **落位**：存到 App 源码的 `avatars/<agentId>.png`，随安装一起复制进 installDir。

4. **读取**：

   ```js
   import { fileURLToPath } from "node:url";
   const APP_DIR = path.dirname(fileURLToPath(import.meta.url));

   function readBundledAvatar(agentId) {
     const file = path.join(APP_DIR, "avatars", `${agentId}.png`);
     if (!fs.existsSync(file)) return null;
     const buf = fs.readFileSync(file);
     return buf.length ? dataUrlOf(buf, file) : null;
   }
   ```

   找不到就回落首字母加主题色，不开天窗。

### 代价

头像从此是 App 的一部分。**新建角色、或换了某个角色的头像，不会自动更新**，得重新打包一次。没打进包的角色回落首字母。

## 排查手法

### 诊断做进界面，别靠嘴问

App 跑在隔离子进程里，内部报错不会流到 Agent 这边。第一轮全靠"改一遍、装上、让用户看对不对"，用户成了排查链上的眼睛。

后来改成：后端把每次尝试的**原始错误信息**拼成一行，前端渲染在副标题下面。用户看一眼就能把原文贴回来，比猜快十倍。

更彻底的落点是**写文件**（诊断结果写进 `dataDir/diag.txt`，Agent 直接读），不依赖用户打开页面。这次没来得及做，下次优先。

### 错误原文是最好的地图

四个字段名试错，全是靠同一句 `requires name` 收窄的。别猜，让报错自己说。

### 截断会骗人

第一次看到的是：

```
allowed: identity.md, AGENTS.md, A
```

那个 `A` 让我以为后面还有戏。放宽到 700 字符才看到完整白名单就三个 md 文件。**看到截断，第一件事是把它放开**，否则判断的是截断而不是事实。

## 参考位置

- 头像随包目录：App 项目下的 `avatars/`
- 头像读取：`index.js` 的 `readAgentAvatar` / `readBundledAvatar`
- 宿主权限代码：`artifacts/server/<version>/bundle/index.js` 搜 `allow-fs-read`
- 校验命令：

  ```powershell
  $env:HANA_APP_TOOLS_ROOT="<Hana 安装目录>/artifacts/server/<version>"
  node "<Hana 安装目录>/skills/hana-app-creator/scripts/validate_app.mjs" --dir "<App 项目目录>" --json
  ```
