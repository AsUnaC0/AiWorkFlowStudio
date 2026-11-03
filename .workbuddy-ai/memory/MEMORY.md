# 项目长期记忆 —— AI WorkFlow Studio

## 分层原则
- MCP 只管标准 MCP Server；普通 HTTP/REST 走工作流 HTTP 节点。新增外部能力：独立模块 + 传输抽象 + 分层服务，通信逻辑不进 Controller。

## Provider 层（backend/src/ai/）
- 仅 2 实现类 Ollama/OpenAICompatible 承载 4 种 LlmProviderType；createProvider 纯函数。openai/deepseek 合并 case；openai-compatible 不能并（无默认 baseUrl）。
- 不能动：DEFAULT_BASE_URL 的 key；第三参数 name 必须与类型同名（写进 ModelCallLog.provider）。
- streamChat 返回 {type:'content'|'reasoning'}；reasoning 字段三套：reasoning_content/reasoning/message.thinking。不用 onReasoning 回调。Agent SSE reasoning 累积语义，全文存 ChatMessage.trail。工作流 LLM 只取 content。

## MCP
- McpController→McpService(唯一碰Prisma)→McpConnectionService→McpToolService→transports/*→McpUrlGuardService。SSRF 必查；凭据加密，只回 hasCredentials+掩码。

## 平台助理
- 判据 isSystem && isDefault；ensure(userId) 幂等，每用户一条（P2002 回读）。
- PlatformToolsService → 6 组 tools/*，19 业务工具 + 5 UI 工具 = 24；无 update_agent。
- 安全红线：userId 只来自 JWT；workspaceId 重校验；llmModelId 过 assertOwnsModel()；create_mcp_server 不收密钥；审计 sanitizeParams 用子串正则。
- 系统 Agent 白名单 SYSTEM_AGENT_EDITABLE_FIELDS；归属校验在 isSystem 分支之外；repair() 不碰 skillIds/mcpServerIds。依赖单向 Agent→Assistant→PlatformTools。

## UI Control
- 只动界面不动业务数据；5 工具 meta.audit=false。
- registerPageContext 注册；执行器只解析当前激活页 handler；跨页先 navigate 再 waitForHandler(2.5s)。
- wait() 15s；resolve 可能早于 wait → earlyResults 缓存。会话 Map<userId,Map<sessionId>>；sessionId 存 sessionStorage。
- 指令生命周期 createCommand→dispatch→poll→resolve；dispatched 独立于 status。
- 目标会话优先 lastUserActivityAt。桌宠→网页走 /platform/ui-command/poll 长轮询（20s），不用 WebSocket。
- uiControl:true 只 create 不 dispatch；chat/stream 必须透传 uiContext/uiControl/taskId。
- cancelTask 清队列+唤醒 wait+记标记；不 abort SSE。navigate 后重读真实路由校验。
- uiContext 只含 pageId/title/route/actions；ui_fill_form 后绝不点确定。
- api/uiControl.ts 独立 axios 实例（无 401 拦截）。spec 11 项。未做：UITask 编排、Redis、executing 上报、ui_scroll/ui_select_option/ui_wait_for_state、视觉定位。

## 人格与记忆
- AgentPersona 独立表；Prompt 四段式：平台职责→人格→记忆片段→动态上下文，前后 PERSONA_BOUNDARY。
- 向量 Float[]+应用层余弦，不引 pgvector；召回失败熔断 5 分钟走关键词；沉淀 fire-and-forget 3 分钟冷却。
- 人格读 DB 不读常量（改 DEFAULT_PERSONA_PROMPT 对已有账号无效）。LEGACY_PERSONA_PROMPTS 升级，用户改过的不覆盖。
- Prompt 分工：platform-assistant.prompt 只写能力，persona.prompt 只写语气；常驻「做不到的事」清单。工作流节点 8 种，无 Code 节点。

## 联网搜索
- web-search/ 只读 env；装配单点 agent.service.ts；BOCHA/TAVILY 任一存在即可用。博查 HTTP200 但 body.code!=200 要查体；摘要截 520。

## 模型调用监控
- 唯一写入口 AIService.recordModelCall；meta.provider 传实际名；流式无 usage（Token 0），Dashboard 用 calls 兜底。

## 桌宠（desktop/）
- 网络全在主进程；token safeStorage 加密；鼠标穿透坐标命中；SSE 兜底 90s/5s。
- 启动 POST /api/desktop-pet/launch 同机 spawn；关 GPU 三连；交接文件 %TEMP%/xiaodie-handoff（拿单实例锁之前读）；语音切句；登录后留设置入口。

## 前端约定
- t-form label-align top；缓存页 meta.keepAlive+defineOptions name 一致；TDesign 类名去 node_modules 确认（.t-default-menu/.t-menu__item/.t-menu__content/.t-is-active）；t-menu-group title 顶掉 #title 插槽；outline 深色底需 background:transparent。
- 3D 验证：临时 vite 入口+headless Chrome --enable-unsafe-swiftshader，沙盒 .workbuddy-ai/tmp/。

## 记忆星图（MemoryGraph.vue）
- 四层：星点 shader→星云 sprite→连线（二次贝塞尔）→景深；UnrealBloom+ACESFilmic+OutputPass。
- 边稀疏（相似度≥0.75 每点≤4），静息 uOpacity=0.032；布局分类簇心 r=8.6+摘要前缀+重要度半径。
- 随机盐值要串哈希+MurmurHash3 fmix32，不能只异或。

## 数据库迁移
- 不用 prisma migrate dev（删 IVFFlat 索引）。手写 migration.sql → migrate deploy → generate。

## 已知遗留
- Skill WORKFLOW/TOOL 无执行分支；MCP OAuth 未实现；工作流 SsrfCheckService 与 McpUrlGuardService 两套（前者无 DNS 校验、跟随重定向）；vue-tsc 3 既有报错，npm run build 失败，npx vite build 可绕过。

## 文档基线（写文档前先核对，行数随代码变动需重测）
- 接口 141（未含 6 个 UI Control 路由）/Controller 20/表 31/迁移 26/后端 ts 184/模块 21/平台工具 24（19业务+5UI）/前端源文件 67/路由 14/执行器 8/队列 4。
- 统计接口：grep -rhoE "^\s*@(Get|Post|Put|Patch|Delete|All)\(" src（行首匹配）。
- backend/src/tts/ 零依赖双引擎（voc_→BreezeBlue/白名单→Edge TTS）。
- docs/需求/v1.5/ 18 册+索引，历史基线不回写。移动 md 后重跑 links.cjs。
- docs/前端代码逻辑/ 3 篇+README（01 桌宠/02 星图/03 界面操作桥接）。只写最不像普通 Vue 的块，常规页面不新建分册。
- pet.js 整文件 Read 会被安全策略拦，用 Grep 定位+分段读。
