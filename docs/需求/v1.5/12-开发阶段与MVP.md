> **分册说明**：本文是《AI WorkFlow Studio 项目需求与技术方案 v1.5（MCP / Skill 更新版）》的拆分分册之一，覆盖原文档**第 23~24 章**（9 个开发阶段与 MVP 范围）。内容与原文一致，仅按模块拆开便于单独阅读。
> **分册索引**：[README](./README.md) ｜ 上一册：[11-前端页面与工程目录.md](./11-前端页面与工程目录.md) ｜ 下一册：[13-产品模型与用户流程.md](./13-产品模型与用户流程.md)

---

# 23. 开发阶段

## Phase 1：基础平台

完成：

- Vue + Vite
- NestJS
- PostgreSQL
- Prisma
- Redis
- Docker
- 登录注册
- JWT
- Workspace
- RBAC

***

## Phase 2：Workflow MVP

完成：

- Workflow CRUD
- Workflow Canvas
- Start
- End
- Input
- Output
- LLM
- 节点连接
- 保存 Workflow
- Workflow 执行

***

## Phase 3：AI

完成：

- AI Provider
- LLM
- Streaming
- Prompt
- Structured Output
- AI 日志
- Token Usage

***

## Phase 4：知识库

完成：

- 文件上传
- PDF / TXT / Markdown
- 文本切分
- Embedding
- pgvector
- 知识库 CRUD（Workspace 级资源）
- KnowledgeRetrievalService 共享检索服务  （被 LLM Node / RAG 节点 / Agent 复用）
- LLM 节点内置 RAG 配置（简单模式：enableRag + knowledgeBaseIds + topK + threshold）
- RAG 独立节点（高级模式：独立 RAG 节点、输出最终答案）
- 前端 LLM 属性面板的知识库配置 UI + RAG 节点的属性面板 UI

***

## Phase 5：高级节点

完成：

- HTTP
- Condition

***

## Phase 6：Agent

完成：

- Agent CRUD
- Agent 配置
- Workflow Tool
- Knowledge Tool
- AgentWorkflow
- AgentKnowledgeBase
- Agent Run
- Agent Tool Calling
- Agent 流式输出
- Agent 执行日志

Agent 只能调用允许访问的已发布 Workflow。

***

## Phase 7：Skill 与 MCP

完成：

- Skill 列表 / 详情 / 启用与停用
- 内置 Skill 与 Workspace 自定义 Skill 的基本管理
- MCP Server 配置、连接测试、工具发现与状态展示
- MCP Tool 输入 Schema 校验、超时、错误处理与调用日志
- 聊天页面选择 Skill / MCP 工具
- Agent 按授权选择 Skill 并调用 MCP Tool
- Workflow LLM 节点配置 Skill 与 MCP 工具白名单
- 权限校验、敏感配置保护、工具调用审计

***

## Phase 8：Agent 结构化输出与导出

完成：

- AgentArtifact 输出契约与 Schema 校验
- 聊天结果区的 Markdown / 表格 / 图表 / 报告渲染
- ECharts 图表渲染与数据校验
- 可选 Markdown / PDF / Word 导出
- 报告生成 Skill（示例能力，不作为独立核心资源）

***

## Phase 9：工程化

完成：

- Workflow Version
- Queue
- Retry
- Timeout
- Cancellation
- Logging
- Monitoring
- API Key
- Audit Log

***

# 24. MVP 范围

第一版不要一次实现所有功能。

MVP 只实现：

```text
登录
 ↓
Workspace
 ↓
Workflow
 ↓
Canvas
 ↓
Start
 ↓
Input
 ↓
LLM
 ↓
Output
 ↓
Run
 ↓
SSE
 ↓
运行结果
```

第二阶段：

```text
Prompt
Knowledge Base 管理
KnowledgeRetrievalService
RAG 独立节点（高级模式）
LLM 内置 RAG（简单模式）
File
```

第三阶段：

```text
HTTP
Condition
```

第四阶段：

```text
Agent
Workflow Tool
Knowledge Tool
Agent Run
```

第五阶段：

```text
Skill Registry
MCP Server / Tool Registry
Chat 中选择 Skill / MCP
Agent Tool Calling
Workflow LLM 节点 Skill / MCP 配置
AgentArtifact（报告 / 表格 / 图表）
聊天结果区渲染
可选 PDF / Word 导出
```

***
