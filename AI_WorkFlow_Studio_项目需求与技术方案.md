# AI WorkFlow Studio
## 项目需求与技术方案 v1.0

> 本文档是 AI WorkFlow Studio 的项目主文档。后续开发、讨论、代码生成、架构调整和功能迭代均应以本文档为主要上下文；若需求发生变化，应优先更新本文档中的对应章节。

---

## 1. 项目概述

### 1.1 项目名称

**AI WorkFlow Studio**

中文名称：**AI 智能工作流平台**

### 1.2 项目定位

AI WorkFlow Studio 是一个面向个人及企业用户的 AI 工作流编排与执行平台。

用户可以通过可视化画布创建工作流，将大语言模型、提示词、知识库、文件、HTTP API、数据库、条件判断、代码处理等能力组合成一个可执行流程。

核心目标：

> **让用户通过拖拽节点的方式，把 AI 能力组合成可重复执行的业务流程。**

典型流程：

```text
用户输入
   ↓
文件上传
   ↓
文档解析
   ↓
知识库检索
   ↓
AI 分析
   ↓
条件判断
   ↓
生成报告
   ↓
导出 PDF / Word
```

### 1.3 项目目标

项目最终应具备以下能力：

1. 用户注册、登录及权限管理
2. 项目 / 工作空间管理
3. 可视化 Workflow 编辑器
4. AI 节点
5. Prompt 节点
6. 知识库 / RAG
7. 文件处理
8. HTTP API 节点
9. PostgreSQL 数据库节点
10. 条件 / 分支节点
11. JavaScript / Code 节点
12. 工作流执行引擎
13. 工作流运行日志
14. AI 流式输出
15. 工作流版本管理
16. 工作流保存、复制、发布
17. 报告生成
18. PDF / Word 导出
19. API Key 管理
20. RBAC 权限控制
21. 操作日志
22. 基础监控和错误处理

---

# 2. 技术栈

## 2.1 前端

| 技术 | 用途 |
|---|---|
| Vue 3 | 前端框架 |
| Vite | 构建工具 |
| TypeScript | 类型系统 |
| Less | CSS 预处理 |
| Vue Router | 路由 |
| Pinia | 状态管理 |
| Axios | HTTP 请求 |
| TDesign Vue Next | UI 组件 |
| Vue Flow | Workflow 可视化画布 |
| ECharts | 数据可视化 |
| CKEditor 5 | 富文本 / 报告编辑 |
| Monaco Editor | Code 节点代码编辑 |
| Markdown | AI 输出展示 |

### 前端原则

- Composition API
- `<script setup lang="ts">`
- 强类型接口
- API 与页面逻辑分离
- 通用组件优先
- Workflow 节点组件独立
- 不在组件内堆积复杂业务逻辑
- 所有后端 API 使用统一 request 封装

---

## 2.2 后端

| 技术 | 用途 |
|---|---|
| NestJS | 后端框架 |
| TypeScript | 类型系统 |
| PostgreSQL | 主数据库 |
| Prisma | ORM / 数据库访问 |
| Redis | 缓存、队列、运行状态 |
| BullMQ | 异步任务 / Workflow 执行 |
| JWT | 身份认证 |
| Passport | NestJS 认证 |
| class-validator | DTO 校验 |
| Swagger | API 文档 |
| SSE | AI 流式输出 |
| WebSocket | 实时状态 |
| Multer | 文件上传 |

---

## 2.3 AI

AI 层需要设计为 Provider 抽象，不允许业务代码直接绑定单一模型。

统一接口：

```ts
interface AIProvider {
  chat(): Promise<string>;
  streamChat(): AsyncGenerator<string>;
  embedding(): Promise<number[]>;
}
```

支持的 Provider 可以包括：

- OpenAI
- DeepSeek
- Gemini
- Claude
- Ollama / 本地模型

AI 能力：

- Chat
- Streaming Chat
- Embedding
- Prompt
- Structured Output
- Tool Calling
- RAG
- Agent

---

## 2.4 向量检索

优先使用：

**PostgreSQL + pgvector**

用于：

- 文档 Embedding
- 向量检索
- RAG
- 知识库问答

暂不强制引入 Milvus / Qdrant，待数据规模达到需求后再考虑独立向量数据库。

---

## 2.5 基础设施

开发环境建议：

```text
Docker
Docker Compose
PostgreSQL
Redis
```

生产环境可根据需要增加：

```text
Nginx
Object Storage / OSS / S3
CI/CD
日志系统
监控系统
```

---

# 3. 系统总体架构

```text
┌──────────────────────────────────────────────┐
│                  Vue 3 前端                  │
│                                              │
│ Dashboard / Workflow / Knowledge / Reports  │
└──────────────────────┬───────────────────────┘
                       │ HTTP / SSE / WebSocket
                       ↓
┌──────────────────────────────────────────────┐
│                 NestJS API                   │
│                                              │
│ Auth / User / Workflow / AI / RAG / Report │
└───────────┬────────────┬────────────┬────────┘
            │            │            │
            ↓            ↓            ↓
       PostgreSQL       Redis       Object Storage
            │            │
            │            └── BullMQ
            │                 ↓
            │          Workflow Worker
            │                 │
            │                 ↓
            │             AI Provider
            │
            └── pgvector
```

---

# 4. 核心概念

## 4.1 Workspace

用户工作的空间。

一个 Workspace 可以包含：

- 用户
- 成员
- 项目
- Workflow
- Knowledge Base
- API Key
- Prompt
- Report

---

## 4.2 Workflow

Workflow 是平台最核心的数据结构。

示例：

```text
Start
  ↓
Input
  ↓
Knowledge Search
  ↓
LLM
  ↓
Condition
 ├── true → Report
 └── false → LLM Rewrite
                 ↓
               Report
```

Workflow 由：

- Nodes
- Edges
- Variables
- Settings

组成。

---

## 4.3 Node

Node 是工作流中的执行单元。

节点必须具有统一生命周期：

```text
input
 ↓
validate
 ↓
execute
 ↓
output
 ↓
next
```

节点需要支持：

```ts
interface WorkflowNode {
  id: string;
  type: string;
  config: Record<string, unknown>;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
}
```

---

# 5. Workflow 节点体系

第一阶段支持：

## 5.1 基础节点

### Start

工作流入口。

### End

工作流结束。

### Input

获取用户输入。

### Output

向用户输出结果。

---

## 5.2 AI 节点

### LLM

用于：

- 文本生成
- 文本总结
- 分类
- 信息提取
- 改写

配置：

```text
Model
Temperature
System Prompt
User Prompt
Max Tokens
Output Format
```

### Embedding

用于生成向量。

### AI Agent

允许模型调用工具。

---

## 5.3 Prompt 节点

用于管理可复用 Prompt。

支持变量：

```text
你是一名专业的数据分析师。

请分析以下数据：

{{data}}

输出：
{{format}}
```

---

## 5.4 RAG 节点

知识库检索：

```text
Query
 ↓
Embedding
 ↓
Vector Search
 ↓
Top K
 ↓
Context
```

---

## 5.5 文件节点

支持：

- PDF
- Word
- Excel
- TXT
- Markdown

基础能力：

- 上传
- 解析
- 文本提取
- 分块
- Embedding

---

## 5.6 HTTP 节点

允许 Workflow 调用第三方 API。

配置：

```text
Method
URL
Headers
Query
Body
Timeout
```

支持变量：

```text
{{node_1.output}}
```

---

## 5.7 PostgreSQL 节点

用于执行受控 SQL。

必须进行：

- SQL 校验
- 权限限制
- 参数化
- 超时控制
- 只读限制（默认）

禁止 Workflow 默认执行危险 SQL。

---

## 5.8 Condition 节点

支持：

```text
if
else
equals
contains
>
<
>=
<=
```

---

## 5.9 Code 节点

允许执行 JavaScript。

第一阶段建议采用受限执行环境。

禁止直接获得：

- 操作系统权限
- 任意文件系统权限
- 任意网络权限
- 环境变量

---

# 6. Workflow 编辑器

核心页面：

```text
┌────────────┬───────────────────────────────┬──────────────┐
│ 节点面板   │          Workflow Canvas      │ 属性面板     │
│            │                               │              │
│ Start      │      ┌───────┐               │ Node Config  │
│ LLM        │      │ Start │               │              │
│ Prompt     │      └───┬───┘               │ Model        │
│ RAG        │          ↓                   │ Prompt       │
│ HTTP       │      ┌───────┐               │ Temperature  │
│ Condition  │      │  LLM  │               │              │
│ Code       │      └───┬───┘               │              │
│ Report     │          ↓                   │              │
│            │      ┌────────┐              │              │
│            │      │ Report │              │              │
└────────────┴───────────────────────────────┴──────────────┘
```

必须支持：

- 拖拽节点
- 删除节点
- 节点连线
- 节点配置
- 节点复制
- 节点禁用
- 多选
- 删除连线
- 缩放
- 平移
- 自动布局（后续）
- 撤销 / 重做
- 保存
- 测试运行
- 发布

---

# 7. Workflow 数据结构

示例：

```json
{
  "nodes": [
    {
      "id": "start",
      "type": "start",
      "config": {}
    },
    {
      "id": "llm_1",
      "type": "llm",
      "config": {
        "model": "xxx",
        "temperature": 0.7,
        "prompt": "{{input}}"
      }
    }
  ],
  "edges": [
    {
      "source": "start",
      "target": "llm_1"
    }
  ]
}
```

Workflow 定义与 Workflow 执行记录必须分离。

---

# 8. Workflow 执行引擎

执行流程：

```text
创建运行记录
     ↓
加载 Workflow
     ↓
校验 DAG
     ↓
寻找 Start
     ↓
执行 Node
     ↓
保存 Node Result
     ↓
寻找下一个 Node
     ↓
执行
     ↓
End
```

每个节点执行必须记录：

```text
runId
nodeId
startTime
endTime
status
input
output
error
duration
```

状态：

```text
PENDING
RUNNING
SUCCESS
FAILED
CANCELLED
```

---

# 9. 异步执行

对于耗时 Workflow：

```text
API
 ↓
创建 Workflow Run
 ↓
BullMQ
 ↓
Worker
 ↓
执行 Workflow
```

前端通过：

```text
SSE
```

获取实时状态：

```text
Node 1 SUCCESS
Node 2 RUNNING
Node 3 PENDING
```

---

# 10. AI Streaming

AI 节点支持流式输出：

```text
Token 1
Token 2
Token 3
...
```

后端：

```text
NestJS
 ↓
AI Provider
 ↓
SSE
 ↓
Vue
```

前端实时显示：

```text
正在分析……

张三具有较强的团队协作能力……
```

---

# 11. 知识库

知识库结构：

```text
Knowledge Base
├── Documents
│   ├── PDF
│   ├── Word
│   ├── TXT
│   └── Markdown
│
└── Chunks
    └── Embeddings
```

处理流程：

```text
上传文件
 ↓
文件解析
 ↓
文本清洗
 ↓
文本切块
 ↓
Embedding
 ↓
PostgreSQL + pgvector
```

查询：

```text
用户问题
 ↓
Embedding
 ↓
向量搜索
 ↓
Top K chunks
 ↓
拼接 Context
 ↓
LLM
 ↓
答案
```

---

# 12. AI Agent

Agent 不是第一阶段的核心依赖，第二阶段实现。

Agent 可以调用：

```text
Search Tool
HTTP Tool
Database Tool
Knowledge Tool
Calculator Tool
Workflow Tool
```

例如：

```text
用户：
分析本月销售数据，并生成报告。

Agent：
1. 查询数据库
2. 分析数据
3. 查询知识库
4. 生成结论
5. 创建报告
```

---

# 13. 报告系统

Workflow 可以生成结构化报告。

报告支持：

- 标题
- 段落
- 表格
- 图片
- 图表
- Markdown
- 富文本
- AI 内容

报告编辑器建议使用：

**CKEditor 5**

支持：

- 富文本编辑
- 加粗
- 斜体
- 标题
- 列表
- 表格
- 图片
- AI 改写

---

# 14. AI 报告生成

示例：

```text
数据
 ↓
AI Analysis
 ↓
Structured JSON
 ↓
Report Template
 ↓
Report
```

AI 输出优先使用 Structured Output，而不是直接拼 HTML。

例如：

```json
{
  "summary": "...",
  "advantages": [
    "...",
    "..."
  ],
  "risks": [
    "..."
  ],
  "suggestions": [
    "..."
  ]
}
```

再由前端 / 后端模板系统渲染。

---

# 15. 用户系统

## 用户

字段：

```text
id
username
email
passwordHash
avatar
status
createdAt
updatedAt
```

## Workspace

```text
id
name
ownerId
createdAt
updatedAt
```

## Workspace Member

```text
workspaceId
userId
roleId
```

---

# 16. RBAC 权限

角色：

```text
Owner
Admin
Editor
Viewer
```

权限示例：

```text
workflow:create
workflow:read
workflow:update
workflow:delete
workflow:run

knowledge:create
knowledge:read
knowledge:delete

report:create
report:export
```

后端必须进行最终权限校验。

前端权限只用于 UI 展示控制，不能作为安全边界。

---

# 17. 数据库核心模型

核心表：

```text
users
workspaces
workspace_members
roles
permissions
role_permissions

workflows
workflow_versions
workflow_nodes
workflow_edges

workflow_runs
workflow_node_runs

ai_providers
ai_models
ai_prompts
ai_conversations
ai_messages

knowledge_bases
documents
document_chunks

reports
report_versions
report_templates

files
api_keys
audit_logs
```

---

# 18. API 设计原则

RESTful API：

```text
/api/auth
/api/users
/api/workspaces
/api/workflows
/api/workflow-runs
/api/knowledge-bases
/api/documents
/api/reports
/api/ai
```

示例：

```http
POST /api/workflows
GET /api/workflows/:id
PUT /api/workflows/:id
DELETE /api/workflows/:id

POST /api/workflows/:id/run
GET /api/workflow-runs/:runId
GET /api/workflow-runs/:runId/events
```

---

# 19. 安全要求

必须考虑：

### Authentication

JWT。

### Password

禁止明文保存。

使用：

```text
Argon2 / bcrypt
```

### API Key

数据库中不能直接保存明文 API Key。

### SQL Node

禁止任意危险 SQL。

### Code Node

必须使用沙箱 / Worker 隔离。

### HTTP Node

需要防止 SSRF。

### 文件上传

需要：

- 类型检查
- 大小限制
- 文件名处理
- 病毒 / 恶意文件检查（生产环境）
- 对象存储隔离

---

# 20. 前端目录建议

```text
src/
├── api/
│   ├── auth.ts
│   ├── workflow.ts
│   ├── knowledge.ts
│   └── report.ts
│
├── assets/
├── components/
│   ├── common/
│   ├── ai/
│   ├── workflow/
│   └── report/
│
├── layouts/
│
├── views/
│   ├── login/
│   ├── dashboard/
│   ├── workflow/
│   ├── knowledge/
│   ├── report/
│   └── settings/
│
├── stores/
├── router/
├── types/
├── utils/
├── hooks/
└── main.ts
```

---

# 21. 后端目录建议

```text
src/
├── auth/
├── users/
├── workspaces/
├── workflows/
│   ├── workflow.controller.ts
│   ├── workflow.service.ts
│   ├── workflow.engine.ts
│   ├── workflow.repository.ts
│   └── nodes/
│       ├── start.node.ts
│       ├── llm.node.ts
│       ├── prompt.node.ts
│       ├── rag.node.ts
│       ├── http.node.ts
│       ├── condition.node.ts
│       ├── code.node.ts
│       └── report.node.ts
│
├── ai/
│   ├── providers/
│   ├── ai.service.ts
│   └── ai.module.ts
│
├── knowledge/
├── documents/
├── embeddings/
├── reports/
├── files/
├── queue/
├── redis/
├── prisma/
├── common/
└── main.ts
```

---

# 22. 开发阶段

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

---

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

---

## Phase 3：AI

完成：

- AI Provider
- LLM
- Streaming
- Prompt
- Structured Output
- AI 日志
- Token Usage

---

## Phase 4：知识库

完成：

- 文件上传
- PDF / TXT / Markdown
- 文本切分
- Embedding
- pgvector
- RAG
- Knowledge Node

---

## Phase 5：高级节点

完成：

- HTTP
- Condition
- PostgreSQL
- Code
- Agent

---

## Phase 6：报告

完成：

- Report Template
- CKEditor 5
- AI Report
- Version
- PDF
- Word

---

## Phase 7：工程化

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

---

# 23. MVP 范围

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
RAG
Knowledge Base
File
```

第三阶段：

```text
HTTP
Condition
SQL
Code
Agent
```

第四阶段：

```text
Report
Template
PDF
Word
```

---

# 24. 开发约束

后续开发必须遵循：

1. TypeScript 严格模式。
2. 前后端均优先保证类型安全。
3. 数据库通过 Prisma 管理。
4. 不直接在 Controller 中实现复杂业务。
5. Workflow Engine 与 HTTP Controller 解耦。
6. Node 必须采用统一接口。
7. AI Provider 必须抽象。
8. Workflow Definition 与 Workflow Run 分离。
9. 所有执行过程必须可追踪。
10. AI 输出尽量采用 Structured Output。
11. 敏感信息不得写入日志。
12. 用户权限必须由后端最终校验。
13. 所有异步任务需要考虑失败、重试和超时。
14. 不为了“看起来功能很多”而过早引入复杂基础设施。
15. 每完成一个阶段，应保证项目可以运行。

---

# 25. 后续与 AI 助手协作规则

以后将本文档提供给 AI 助手时，应将其视为：

> **AI WorkFlow Studio 的项目上下文和技术基线。**

AI 助手在修改代码或设计功能前，应先理解：

```text
项目定位
↓
技术栈
↓
系统架构
↓
数据模型
↓
Workflow 模型
↓
当前开发阶段
↓
当前需求
```

如果用户提出的新需求与本文档冲突，应先指出冲突，而不是直接覆盖原设计。

如果需要修改核心架构，应明确说明：

```text
为什么修改
修改哪些模块
对已有代码的影响
数据库是否需要迁移
是否影响 Workflow 数据结构
是否影响 API
```

---

# 26. 后续开发方式

后续开发建议采用：

```text
需求
 ↓
数据库设计
 ↓
API 设计
 ↓
后端实现
 ↓
前端实现
 ↓
联调
 ↓
测试
 ↓
文档更新
```

不要一次生成整个项目。

优先按照模块逐步开发：

```text
1. 基础工程
2. Auth
3. Workspace
4. Workflow CRUD
5. Workflow Canvas
6. Workflow Engine
7. AI Provider
8. LLM Node
9. SSE
10. Knowledge Base
11. RAG
12. Advanced Nodes
13. Report
14. Deployment
```

---

# 27. 项目最终目标

最终形成一个类似简化版：

```text
Dify
+
n8n
+
AI Report Studio
```

的 AI 工作流平台。

核心差异不是简单复制这些产品，而是通过项目学习并实现：

- 全栈架构
- 可视化 Workflow
- AI Provider 抽象
- LLM
- RAG
- Agent
- 向量检索
- 异步任务
- SSE
- RBAC
- PostgreSQL
- Redis
- 文件系统
- 报告生成
- Workflow Engine

最终目标：

> **这是一个可以真实运行的 AI SaaS，而不是一个单纯展示 AI Chat 的 Demo。**
