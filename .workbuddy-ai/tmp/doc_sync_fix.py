# -*- coding: utf-8 -*-
import io, sys, os

BASE = r"C:/Users/meibus/Desktop/AI WorkFlow Studio/docs"

def fix(path, repls, append=None):
    full = os.path.join(BASE, path)
    with io.open(full, "r", encoding="utf-8") as f:
        s = f.read()
    for old, new in repls:
        cnt = s.count(old)
        if cnt == 0:
            print(f"  [WARN] not found in {path}: {old[:60]!r}")
        elif cnt > 1:
            print(f"  [INFO] {cnt}x replaced in {path}: {old[:50]!r}")
        s = s.replace(old, new)
    if append:
        s = s.rstrip("\n") + "\n\n" + append + "\n"
    with io.open(full, "w", encoding="utf-8") as f:
        f.write(s)
    print(f"  [OK] {path}")

print("=== 教程/08 ===")
fix("教程/08-前后端数据对照总表.md", [
 ("全部 **139** 个接口逐一拆解", "全部 **141** 个接口逐一拆解"),
 ("📌 **接口总数已更新为 138**", "📌 **接口总数已更新为 141**"),
 ("\n> 相对上一版记录的 126 个，本次补录了 **12 个**新接口：\n> **人格 4 个**（`/agents/:id/persona*`）+ **长期记忆 8 个**（`/memories*`），见 §6.9。",
  "\n> 相对上一版记录的 126 个，本次补录了 **14 个**新接口：\n> **人格 4 个**（`/agents/:id/persona*`）+ **长期记忆 8 个**（`/memories*`）+ **桌宠 1 个**（`/desktop-pet/launch`，见 §3.15）+ **TTS 1 个**（`/tts/synthesize`，见 §6.10），见 §6.9。"),
 ("> 全后端实际 **138** 个接口，覆盖 **18 个 Controller**", "> 全后端实际 **141** 个接口，覆盖 **20 个 Controller**"),
 ("**Memory（★ 长期记忆）**。**", "**Memory（★ 长期记忆）**、**TTS（★ 语音合成）**、**DesktopPet（★ 桌宠启动）**。"),
 ("**★ 模块分布**：Agent 13、Friendship 6、Skill 5、MCP 9、", "**★ 模块分布**：Agent 13、Friendship 6、Skill 5、MCP 10、"),
 ("**Persona 4（本次新增）**、**Memory 8（本次新增）**", "**Persona 4（本次新增）**、**Memory 8（本次新增）**、**TTS 1（本次新增）**、**DesktopPet 1（本次新增）**"),
 ("**138 个接口全览：**", "**141 个接口全览：**"),
 ("\n> 合计 **138**（= 3+2+8+14+8+5+6+13+6+5+9+15+10+10+3+9+4+8）。", "\n> 合计 **141**（= 3+2+8+14+8+5+6+13+6+5+10+15+10+10+3+9+4+8+1+1）。"),
 ("\n> 上一版记的是 126，差额 12 = 人格 4 + 长期记忆 8（见 §6.9）。", "\n> 上一版记的是 126，差额 14 = 人格 4 + 长期记忆 8 + 桌宠 1 + TTS 1（见 §3.15 / §6.10）。"),
 ("> 真实覆盖结论：**后端 138 个接口", "> 真实覆盖结论：**后端 141 个接口"),
 ("| 08（本篇） | 全部 **138** 个接口的“字典” |", "| 08（本篇） | 全部 **141** 个接口的“字典” |"),
 ("> **当前实际是 138 个接口 / 31 张表**", "> **当前实际是 141 个接口 / 31 张表**"),
 ("| **接口总数** | 126 → **139**（138 + 桌宠启动 1） |", "| **接口总数** | 126 → **141**（138 + 桌宠 1 + TTS 1） |"),
 ("（`接口 126 → 138、§3.14、目录树）", "（`接口 126 → 141、§3.14、§3.15、§3.16、目录树）"),
 # interface overview table: append TTS + DesktopPet rows after Memory row
 ("| **Memory（长期记忆）** | **8** ★ 新增 | `/memories/*` ← 见 **§6.9** |",
  "| **Memory（长期记忆）** | **8** ★ 新增 | `/memories/*` ← 见 **§6.9** |\n| **TTS（语音合成）** | **1** ★ 新增 | `/tts/synthesize` ← 见 **§6.10** |\n| **DesktopPet（桌宠启动）** | **1** ★ 新增 | `/desktop-pet/launch` ← 见 **§3.15** |"),
], append="""### 6.10 ★ TTS 语音合成（`src/tts/`，1 个接口，本次新增）

桌宠「边读边出字」的**后端兜底**通道：桌宠优先用本地 TTS，本地失败或没装时回退到这个后端代理把文本合成 mp3。

| 方法 | 路径 | 鉴权 | 前端 API | 说明 |
|------|------|------|----------|------|
| POST | `/api/tts/synthesize` | 需 | `synthesizeTts()` | body `{ text, voice?, rate?, pitch? }` → `{ format:'mp3', audio: base64 }` |

- `voice` 必须是服务端白名单 `VOICE_IDS`（`persona/persona.prompt.ts` 定义，与桌宠音色一致），否则回落默认 `zh-CN-XiaoyiNeural`；
- `rate` 默认 `1.0`（可传 `+50%` 这类相对值），`pitch` 默认 `+0Hz`；
- 用 `msedge-tts` 而不是 `edge-tts`：微软当前要求 Sec-MS-GEC **v2** 令牌（`edge-tts@1.0.x` 只发 v1，直接 403）；`msedge-tts` 已实现 v2 且带时钟偏差校正；
- `TtsService.synthesize()` 先把文本按句切片（≤800 字/段）逐段合成再 `Buffer.concat` 拼接，单段失败仅 `warn` 跳过，不中断整体；
- 音频以 base64 包在 JSON 返回，便于桌宠复用既有 JSON 请求通道（不另开二进制流）；
- 模块**零依赖**：`TtsModule` 只注册 Controller + Service，不碰 Prisma（详见 [后端代码逻辑 08](./08-MCP-Skill-Storage-其他模块.md) 第九节）。""")

print("=== 教程/00 ===")
fix("教程/00-总览与技术选型.md", [
 ("## 3. 全站接口地图（后端一共 **139** 个接口）", "## 3. 全站接口地图（后端一共 **141** 个接口）"),
 ("\n> → **139**（「桌宠客户端」新增 `/desktop-pet/launch` 1，见 §3.15）。",
  "\n> → **139**（「桌宠客户端」新增 `/desktop-pet/launch` 1，见 §3.15）。\n> → **141**（「TTS 语音合成」新增 `/tts/synthesize` 1，见 §3.16）。"),
 ("**各模块接口数核对（合计 139）**：", "**各模块接口数核对（合计 141）**："),
 ("+ Agent 13 + Friendship 6 + Skill 5 + MCP 9 + **LlmConfig 15**", "+ Agent 13 + Friendship 6 + Skill 5 + MCP 10 + **LlmConfig 15**"),
 ("**DesktopPet 1** = **139**", "**TTS 1** + **DesktopPet 1** = **141**"),
 ("### 6.1 后端目录（178 个 TypeScript 源文件", "### 6.1 后端目录（181 个 TypeScript 源文件"),
 ("├── app.module.ts               # 根模块，装配下面 20 个业务模块", "├── app.module.ts               # 根模块，装配下面 21 个业务模块"),
 # tree: insert tts before workflows
 ("└── workflows/                  # 工作流 + 执行引擎（★ 第 4 篇详解）",
  "├── tts/                        # ★【新增】TTS 语音合成（第 8 篇第九节，1 个接口）\n│   ├── tts.controller.ts       #   POST /tts/synthesize（voice 限白名单，返回 base64 mp3）\n│   ├── tts.service.ts          #   msedge-tts 合成 + 长文本按句切片拼接\n│   └── tts.module.ts           #   导出 TtsService（被桌宠复用）\n│\n└── workflows/                  # 工作流 + 执行引擎（★ 第 4 篇详解）"),
 # §3.16 after §3.15 end
 ("> 桌宠自己的业务请求（拉助理信息 / SSE 对话）都走既有接口，不经过这里。",
  """> 桌宠自己的业务请求（拉助理信息 / SSE 对话）都走既有接口，不经过这里。

### 3.16 ★ TTS 语音合成 `src/tts/`（1 个接口，本次新增）

桌宠「边读边出字」的**后端兜底**：桌宠优先用本地 TTS，本地失败 / 没装时回退到这个后端代理把文本合成 mp3。

| 方法 | 路径 | 鉴权 | 前端 API | 说明 |
|------|------|------|----------|------|
| POST | `/api/tts/synthesize` | 需 | `synthesizeTts()` | 文本 → 返回 `{ format:'mp3', audio: base64 }` |

- `voice` 必须是服务端白名单 `VOICE_IDS`（定义在 `persona/persona.prompt.ts`，与桌宠音色一致），否则回落默认 `zh-CN-XiaoyiNeural`；
- 用 `msedge-tts`（不是 `edge-tts`）：微软现要求 Sec-MS-GEC **v2** 令牌，`edge-tts@1.0.x` 只发 v1 会 403；
- 长文本按句切片（≤800 字/段）逐段合成再拼接，降低首字延迟；单段失败只 warn 跳过不中断；
- 音频以 base64 包在 JSON 里返回，便于桌宠复用既有 JSON 请求通道（不另开二进制流）；
- 模块零依赖：`TtsModule` 只注册 Controller + Service，不碰 Prisma（见 [后端代码逻辑 08](../后端代码逻辑/08-MCP-Skill-Storage-其他模块.md) 第九节）。"""),
])

print("=== 后端代码逻辑/01 ===")
fix("后端代码逻辑/01-项目架构与入口.md", [
 ("└── DesktopPetModule     ← ★ 桌宠客户端启动器（spawn 本机 Electron），见 12 §11",
  "├── TtsModule          ← ★ TTS 语音合成（桌宠后端兜底，/tts/synthesize），见 08 第九节\n└── DesktopPetModule     ← ★ 桌宠客户端启动器（spawn 本机 Electron），见 12 §11"),
])

print("=== 后端代码逻辑/08 ===")
fix("后端代码逻辑/08-MCP-Skill-Storage-其他模块.md", [
 # capabilities row into MCP interface list
 ("| GET | `/mcp-servers/:id/tools` | 实时发现工具列表（不落库） |",
  "| GET | `/mcp-servers/:id/tools` | 实时发现工具列表（不落库） |\n| GET | `/mcp-servers/capabilities` | 传输能力：`{ transports, stdio: { enabled, allowedCommands } }`，前端据此决定是否显示 stdio 选项（**须声明在 `:id` 之前**，否则被 `ParseUUIDPipe` 拒成 400） |"),
], append="""## 九、TTS 语音合成（★ 新增模块）

**目录**：`backend/src/tts/`，**零依赖**（`TtsModule` 只注册 Controller + Service，不碰 Prisma）。

桌宠「边读边出字」的**后端兜底通道**：桌宠优先用本地 TTS，本地失败或没装时回退到这个后端代理把文本合成 mp3。

### 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/tts/synthesize` | body `{ text, voice?, rate?, pitch? }` → `{ format: 'mp3', audio: base64 }` |

- `voice` 必须是服务端白名单 `VOICE_IDS`（`persona/persona.prompt.ts` 定义，与桌宠音色一致），否则回落默认 `zh-CN-XiaoyiNeural`；
- `rate` 默认 `1.0`（可传 `+50%` 这类相对值），`pitch` 默认 `+0Hz`；
- 用 `msedge-tts` 而不是 `edge-tts`：微软当前要求 Sec-MS-GEC **v2** 令牌（`edge-tts@1.0.x` 只发 v1，直接 403）；`msedge-tts` 已实现 v2 且带时钟偏差校正；
- `TtsService.synthesize()` 先把文本按句切片（≤800 字/段）逐段合成再 `Buffer.concat` 拼接，单段失败仅 `warn` 跳过，不中断整体；
- 音频以 base64 包在 JSON 返回，便于桌宠复用既有 JSON 请求通道（不另开二进制流）。

> 与桌宠的关系：桌宠客户端（`desktop/`）自己有本地 TTS，「语音边读边出字」优先本地；本接口是**后端兜底**，保证没装本地语音引擎时桌宠仍能出声。详见 [教程 00 §3.16](../教程/00-总览与技术选型.md)。""")

print("=== 命令.md ===")
fix("命令.md", [
 ("| `storage/` | 统一存储（本地 / 七牛云） | 08 |\n\n文档入口：",
  "| `storage/` | 统一存储（本地 / 七牛云） | 08 |\n| `tts/` | TTS 语音合成（桌宠后端兜底，`/tts/synthesize`） | 08 第九节 |\n| `persona/` | 平台助理人格配置（`/agents/:id/persona`） | 12 |\n| `memory/` | 长期记忆沉淀 / 召回 / 3D 网络（`/memories`） | 12 |\n| `desktop-pet/` | 桌宠客户端启动器（`/desktop-pet/launch`） | 12 §11 |\n| `friendship/` | 好友关系（`/friendships`） | — |\n| `workspaces/` | 工作空间 + 成员（`/workspaces`） | 08 四 |\n| `skill/` | 技能资源（`/skills`） | 08 二 |\n| `dashboard/` | 首页仪表盘（`/dashboard`） | 08 五 |\n| `queues/` | 异步任务队列（BullMQ） | 05 / 教程 00 §6.2 |\n| `ai/` | 大模型 Provider 门面（`/ai`） | 03 |\n\n文档入口："),
])

print("=== 后端代码逻辑/README.md ===")
fix("后端代码逻辑/README.md", [
 ("| 29 | 12 | 补 **登录态交接**（12 §11.0 新增小节）",
  "| 29 | 12 | 补 **登录态交接**（12 §11.0 新增小节） |\n| 30 | 全局 | **同步第七轮（2026-10-28）**：实测后端 **141** 接口 / **20** Controller / **31** 表 / **25** 迁移 / **181** 个 `.ts` / `schema.prisma` **1029** 行 / 注册模块 **21**；补 **TTS 模块**（`/tts/synthesize` 1 接口，零依赖，桌宠后端兜底）到 08 第九节、教程 00 §3.16、教程 08 §6.10、命令.md 模块表；MCP 接口表补 `GET /mcp-servers/capabilities`（共 10 个）；模块树补 `TtsModule`；各基线数字（138/139→141、18→20、852→1029、175/178→181、23→25）统一对齐 |"),
])

print("=== 文档同步检查报告.md ===")
fix("文档同步检查报告.md", [
 ("- 接口 **126**、数据表 **25**、Controller **16**、平台工具 **17**、迁移 **23**\n- `schema.prisma` **852 行**、后端 **163** 个 `.ts`、前端 **60** 个文件（32 `.ts` + 28 `.vue`）\n- Dashboard **10** 个接口、MCP **9** 个接口、节点执行器 **8** 种、前端 **13** 条路由（keepAlive 仅 chat）",
  "- 接口 **141**、数据表 **31**、Controller **20**、平台工具 **19**、迁移 **25**、注册模块 **21**\n- `schema.prisma` **1029 行**、后端 **181** 个 `.ts`（前端源文件数见 教程 00）\n- Dashboard **10** 个接口、MCP **10**（3 种传输：Streamable HTTP / SSE / STDIO）个接口、节点执行器 **8** 种、TTS **1** 个接口、桌宠启动 **1** 个接口"),
 ("### 2.6 第六轮（2026-10-23）· 本次清理",
  "### 2.6 第六轮（2026-10-23）· 本次清理"),
], append="""### 2.7 第七轮（2026-10-28）· 基线对齐 + TTS 补文档

实测当前代码并统一各篇基线（此前 教程 00 记 139、教程 08 记 138，均滞后）：

| # | 文档 | 问题 | 修复 |
|---|------|------|------|
| 1 | 教程 00 / 教程 08 / 同步报告 / 审查报告 | 接口数 138 / 139 → 实际 **141**（差在 TTS 1、MCP 实为 10、桌宠 1） | 全部改为 **141** |
| 2 | 同上 | Controller 18 → 实际 **20**（新增 persona / memory / tts / desktop-pet 各 1） | 改为 **20** |
| 3 | 01 / 教程 01 / 同步报告 / 审查报告 | 迁移 23 → 实际 **25**（补 `20261026180000_mcp_stdio_transport` + `20261028120000_add_persona_pet_memory`） | 改为 **25** |
| 4 | 教程 00 / 同步报告 / 审查报告 | 后端 `.ts` 178 / 175 → 实际 **181**；`schema.prisma` 852 → 实际 **1029** 行 | 改为 **181** / **1029** |
| 5 | 01 / 教程 00 模块树 | 缺 `TtsModule`（注册模块 20 → 实际 **21**） | 模块树补 `TtsModule` |
| 6 | 命令.md 模块速查表 | 仅列 10 个目录，缺 tts / persona / memory / desktop-pet / friendship / workspaces / skill / dashboard / queues / ai | 补 11 行 |
| 7 | 08（后端逻辑）/ 教程 08 | MCP 接口表缺 `GET /mcp-servers/capabilities`（共 9 → **10**）；TTS 模块完全无文档 | 补 capabilities 行 + 新增 TTS 章节 |
| 8 | 教程 00 / 教程 08 | 缺 TTS 接口章节 | 新增 §3.16 / §6.10，列 `POST /tts/synthesize` |

> TTS 模块要点：`backend/src/tts/` 零依赖，`POST /tts/synthesize` 用 `msedge-tts`（v2 令牌）把文本合成 base64 mp3，是桌宠「边读边出字」的后端兜底；`voice` 受限服务端白名单 `VOICE_IDS`。详见 08 第九节。

> 下次检查建议：保持「新增模块即补文档」节奏；重点复核 `fronted/src` 前端源文件数（当前约 70 个，随记忆/人格/桌宠面板增长）与后端 `.ts` 是否同步更新。""")

print("=== 后端代码逻辑审查报告.md ===")
fix("后端代码逻辑审查报告.md", [
 ("| 接口总数 | **126**（全量 `@Get/@Post/@Put/@Delete` 装饰器计数） |",
  "| 接口总数 | **141**（行首路由装饰器计数，排除注释误匹配） |"),
 ("| 数据表 / Controller / 平台工具 | **25** / **16** / **17** |",
  "| 数据表 / Controller / 平台工具 / 注册模块 | **31** / **20** / **19** / **21** |"),
 ("| 迁移 | **23**（`prisma/migrations` 目录数，另有 `migration_lock.toml` 不计） |",
  "| 迁移 | **25**（`prisma/migrations` 目录数，另有 `migration_lock.toml` 不计） |"),
 ("| `schema.prisma` / 后端 `.ts` | **852 行** / **163 个** |",
  "| `schema.prisma` / 后端 `.ts` | **1029 行** / **181 个** |"),
 ("| 前端 `src` | **60 个文件**（32 `.ts` + 28 `.vue`） |",
  "| 前端 `src` | 见 教程 00（约 70 个文件） |"),
 ("| `docs/` | **28 篇 .md** |",
  "| `docs/` | **31 篇 .md**（后端逻辑 13 + 教程 11 + 需求 4 + 根 3） |"),
])

print("DONE")
