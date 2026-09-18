# AI WorkFlow Studio

## 项目需求与技术方案 v1.4

> 本文档是 AI WorkFlow Studio 的项目主文档。后续开发、讨论、代码生成、架构调整和功能迭代均应以本文档为主要上下文；若需求发生变化，应优先更新本文档中的对应章节。
>
>   v1.4 更新说明：   RAG 节点重新定位为   RAG 节点（完整管线节点）  ，内部集成 Embedding + 向量检索 + LLM 生成，配置项独立且精细（可单独指定 Embedding 模型、检索策略、生成参数等）。同时 LLM 节点的内置知识库配置（简单模式快捷方式）保留不变。两种模式的关系：
>
> | 模式       | 节点形态          | 适用场景                                                         |
> | -------- | ------------- | ------------------------------------------------------------ |
> |   简单模式   | LLM 节点勾选知识库配置 | 快速搭建，使用默认 Embedding 模型和检索参数                                  |
> |   高级模式   | 独立 RAG 节点     | 精细控制完整 RAG 管线——可独立配置 Embedding 模型、Top K、相似度阈值、检索模式、LLM 生成参数等 |
>
> 两种模式式式共享底层 KnowledgeRetrievalService式式。RAG 节点本身就是完整的知识问答节点，执行完 Embedding → 检索 → LLM 生成后直接输出最终答案。
>
>   v1.3 更新说明：   RAG 能力双模式设计（Retrieval 纯检索节点 + LLM 内置 RAG）。
>
>   v1.1.1 更新说明：   将"知识库"从 Workflow 中独立的 RAG 节点，重新定位为 LLM 大模型节点的内置配置项。
>
>   v1.1.0 更新说明：   明确 Workspace → Workflow 列表 → Workflow Editor 的页面层级；增加好友、Workspace 邀请、公开 Workspace / Workflow 机制；将 Agent 调用已发布 Workflow 确定为后续核心应用链路；重新定位 AI Report 为 Agent 的一种输出能力。

***

## 1. 项目概述

### 1.1 项目名称



AI WorkFlow Studio



中文名称：：：AI 智能工作流平台：：

### 1.2 项目定位

AI WorkFlow Studio 是一个面向个人及企业用户的 AI 工作流编排与执行平台。

用户可以通过可视化画布创建工作流，将大语言模型、提示词、RAG 知识问答、文件、HTTP API、数据库、条件判断、代码处理等能力组合成一个可执行流程。知识库作为 Workspace 级资源独立管理，在 Workflow 中通过两种方式使用——LLM 节点内置配置（简单模式）或独立 RAG 节点（高级模式），两种方式共享同一 KnowledgeRetrievalService。

核心目标：

>   让用户通过拖拽节点的方式，把 AI 能力组合成可重复执行的业务流程。  

典型使用方式分为两条链路：

### Workflow 能力构建链路

```text
进入 Workspace
   ↓
Workflow 列表
   ↓
创建 / 选择 Workflow
   ↓
Workflow Editor
   ↓
配置节点
   ↓
测试运行
   ↓
查看运行结果
   ↓
发布 Workflow
```

### Agent 应用链路

```text
用户需求
   ↓
Agent
   ├── 调用已发布 Workflow
   ├── 调用 Knowledge Base
   ├── 调用其他工具
   ↓
AI 分析 / 决策
   ↓
最终输出
   ├── 普通回答
   ├── 结构化数据
   └── 报告
   ↓
可选：编辑 / 导出 PDF / Word
```

> Workflow 中的“运行”主要用于开发和测试当前 Workflow；正式面向用户的复杂业务应用，优先通过 Agent 调用已经发布的 Workflow。
>
> “AI 报告”不是 Workspace 下与 Workflow、Knowledge Base、Agent 并列的核心资源，而是 Agent 的一种应用场景和输出能力。

### 1.3 项目目标

项目最终应具备以下能力：

1. 用户注册、登录及权限管理
2. 项目 / 工作空间管理
3. 可视化 Workflow 编辑器
4. AI 节点
5. Prompt 节点
6. 知识库管理（Workspace 级资源）+ LLM 节点内置 RAG 配置
7. 文件处理
8. HTTP API 节点
9. 条件 / 分支节点
10. 工作流执行引擎
11. 工作流运行日志
12. AI 流式输出
13. 工作流版本管理
14. 工作流保存、复制、发布
15. Agent 调用已发布 Workflow
16. Agent 调用 Knowledge Base / Tools
17. Agent 多类型输出（文本 / JSON / 报告）
18. 报告编辑及可选 PDF / Word 导出
19. API Key 管理
20. RBAC 权限控制
21. 操作日志
22. 基础监控和错误处理

***

# 2. 技术栈

## 2.1 前端

| 技术               | 用途             |
| ---------------- | -------------- |
| Vue 3            | 前端框架           |
| Vite             | 构建工具           |
| TypeScript       | 类型系统           |
| Less             | CSS 预处理        |
| Vue Router       | 路由             |
| Pinia            | 状态管理           |
| Axios            | HTTP 请求        |
| TDesign Vue Next | UI 组件          |
| Vue Flow         | Workflow 可视化画布 |
| ECharts          | 数据可视化          |
| CKEditor 5       | 富文本 / 报告编辑     |
| Markdown         | AI 输出展示        |

### 前端原则

- Composition API
- `<script setup lang="ts">`
- 强类型接口
- API 与页面逻辑分离
- 通用组件优先
- Workflow 节点组件独立
- 不在组件内堆积复杂业务逻辑
- 所有后端 API 使用统一 request 封装

***

## 2.2 后端

| 技术              | 用途                 |
| --------------- | ------------------ |
| NestJS          | 后端框架               |
| TypeScript      | 类型系统               |
| PostgreSQL      | 主数据库               |
| Prisma          | ORM / 数据库访问        |
| Redis           | 缓存、队列、运行状态         |
| BullMQ          | 异步任务 / Workflow 执行 |
| JWT             | 身份认证               |
| Passport        | NestJS 认证          |
| class-validator | DTO 校验             |
| Swagger         | API 文档             |
| SSE             | AI 流式输出            |
| WebSocket       | 实时状态               |
| Multer          | 文件上传               |

***

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

***

## 2.4 向量检索

优先使用：



PostgreSQL + pgvector



用于：

- 文档 Embedding
- 向量检索
- RAG
- 知识库问答

暂不强制引入 Milvus / Qdrant，待数据规模达到需求后再考虑独立向量数据库。

***

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

***

# 3. 系统总体架构

```text
┌──────────────────────────────────────────────┐
│                  Vue 3 前端                  │
│                                              │
│ Dashboard / Workspace / Workflow / Knowledge / Agent │
└──────────────────────┬───────────────────────┘
                       │ HTTP / SSE / WebSocket
                       ↓
┌──────────────────────────────────────────────┐
│                 NestJS API                   │
│                                              │
│ Auth / User / Workspace / Workflow / AI / Agent │
│                                              │
│ KnowledgeRetrievalService（共享）              │
│   ├── LLM Node（简单模式）                    │
│   ├── RAG 节点（高级模式）              │
│   └── Agent Knowledge Tool                    │
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
            └── pgvector（向量检索）
```

***

# 4. 核心概念

## 4.1 Workspace

Workspace 是用户组织和创建 AI 能力的工作空间。

Workspace 的核心职责是：

- 管理工作流
- 管理知识库
- 管理 Agent
- 管理成员及协作权限
- 管理 API Key 等工作空间级资源

一个 Workspace 可以包含：

- Owner
- Members
- Workflow
- Knowledge Base
- Agent
- API Key
- Prompt

### Workspace 与工作流页面层级

用户在工作台点击某个 Workspace 后，不直接进入某一个 Workflow，而是先进入 Workspace 内的资源页面，默认进入 Workflow 列表：

```text
工作台
   ↓
Workspace
   ↓
Workflow 列表
   ↓
选择 Workflow
   ↓
Workflow Editor
```

Workspace 是资源容器，Workflow 是 Workspace 中可独立创建、编辑、测试和发布的能力。

### Workspace 可见性

Workspace 支持：

```text
PRIVATE
PUBLIC
```

- `PRIVATE`：仅 Workspace 成员可以访问。
- `PUBLIC`：非成员可以进入用户主页后查看该 Workspace 的公开内容，但不因此获得编辑权限。

### Workspace 协作规则

- 用户可以邀请好友加入 Workspace。
- 只有接受邀请并成为 `WorkspaceMember` 的用户，才成为 Workspace 的协作者。
- 按当前产品设定，Workspace 成员默认具有编辑 Workspace 内 Workflow 的能力；后续如有需要再扩展 Owner / Editor / Viewer 等更细粒度角色。
- “好友关系”与“Workspace 成员关系”必须分离。成为好友不会自动获得 Workspace 访问或编辑权限。
- 未加入 Workspace 的用户，即使是好友，也只能按照 Workspace / Workflow 的公开设置查看公开内容。
- 非成员不能通过公开访问直接修改原 Workflow；如需要使用，可复制到自己的 Workspace，形成独立 Workflow。

### 用户主页与公开 Workspace

用户可以通过头像进入其他用户主页。

如果对方存在 `PUBLIC` Workspace，则可以查看其公开 Workspace，并进入其中允许公开查看的 Workflow。

```text
用户主页
   ↓
公开 Workspace
   ↓
Workflow 列表
   ↓
公开 Workflow
   ├── 查看
   ├── 运行（若允许）
   └── 复制到自己的 Workspace
```

公开查看不等于加入 Workspace，也不等于获得编辑权限。

***

## 4.2 Workflow

Workflow 是平台最核心的数据结构。

### 示例一：简单模式（LLM 内置知识库配置）

适合快速搭建问答类场景，一个 LLM 节点内完成检索 + 生成：

```text
Start
  ↓
Input
  ↓
LLM（配置：启用知识库 + 关联"企业制度知识库"）
  ↓
Condition
 ├── true → Report
 └── false → LLM Rewrite
                 ↓
               Report
```

### 示例二：高级模式（独立 RAG 节点，完整管线）

适合需要精细控制 RAG 管线各环节的场景（独立配置 Embedding 模型、检索策略、LLM 生成参数等）：

```text
Start
  ↓
Input
  ↓
RAG（配置：知识库="产品知识库"，Embedding 模型=text-embedding-v2，Top K=10，LLM=deepseek-chat）
  ↓
Output（直接输出最终答案）
```

RAG 节点也可以和其他节点组合使用，例如：

```text
Input
  ↓
RAG（产品知识库）
  ↓
LLM（将 RAG 答案润色成报表格式）
  ↓
Report
```

>   v1.4 双模式说明：   两种模式的核心差异在于   配置的精细程度  ：
>
> -   简单模式  ：在 LLM 节点勾选知识库 → 使用默认 Embedding 模型 + 默认检索参数，快速搭建
> -   高级模式  ：独立 RAG 节点 → 可独立选择 Embedding 模型、检索模式、Top K、相似度阈值、LLM 模型、Prompt 等全链路参数
> - 两者底层都调用 KnowledgeRetrievalService，执行的完整管线相同

Workflow 由：

- Nodes
- Edges
- Variables
- Settings

组成。

***

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

***

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

***

## 5.2 AI 节点

### LLM

用于：

- 文本生成
- 文本总结
- 分类
- 信息提取
- 改写
-   RAG 增强问答（简单模式，推荐新手使用）  

>   v1.3 双模式提示：   本节介绍的是   简单模式  ——在 LLM 节点中直接勾选知识库即可获得 RAG 能力。对于需要精细控制检索流程的高级场景（如检索结果对接 Condition / 多个 LLM 等），请使用独立的   RAG 节点  （见 5.4 节）。两种模式共享同一底层检索服务。

配置：

```text
基础配置：
  Model
  Temperature
  System Prompt
  User Prompt
  Max Tokens
  Output Format

知识库配置（可选，v1.3 简单模式）：
  ☑ 启用知识库检索
  关联知识库（多选）：
    ├── 知识库 A
    ├── 知识库 B
    └── ...
  检索 Top K
  相似度阈值
  检索模式（混合检索 / 向量检索 / 关键词检索）
```

LLM 节点内置 RAG 能力的执行流程：

```text
LLM 节点执行
  ↓
检查是否启用知识库检索
  ↓（启用时）
  调用 KnowledgeRetrievalService（与独立 RAG 节点共用同一服务）
  ↓
  用用户输入 / User Prompt 构造查询
  ↓
对每个关联知识库执行向量检索
  ↓
合并检索结果（去重、按分数排序、截断 Top K）
  ↓
将检索到的上下文片段注入 System Prompt（或作为 {{rag_context}} 变量注入）
  ↓
发送完整 Prompt + Context + User Input 给 LLM
  ↓
返回生成结果
```

### 共享底层：KnowledgeRetrievalService

无论是 LLM 节点内置的 RAG（简单模式）、独立 RAG 节点（高级模式），还是 Agent 的 Knowledge Tool，都调用用用同一个后端服务用用：

```text
KnowledgeRetrievalService
  ├── search(knowledgeBaseIds, query, topK, threshold, mode)
  ├── hybridSearch(...)
  ├── vectorSearch(...)
  └── keywordSearch(...)
```

这样保证了：

- 三种入口返回一致的检索质量和格式
- 检索逻辑只维护一份
- 便于后续统一优化（如重排序 Rerank）

### Embedding

用于生成向量。

### AI Agent

AI Agent 不作为第一阶段 Workflow 的核心节点。

平台中的 Agent 是独立的应用能力，负责根据用户需求决定是否调用已发布 Workflow、Knowledge Base 或其他工具。

如果未来需要在 Workflow 内实现 Agent Node，可将其作为高级节点扩展，但不得与平台级 Agent 概念混淆。

***

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

***

## 5.4 RAG 节点（高级模式）

>   v1.4 重写：   RAG 节点是是是完整的知识问答节点是是，内部集成 Embedding → 向量检索 → LLM 生成的完整管线。与 LLM 节点的内置知识库配置（简单模式）相比，RAG 节点提供独立且精细的配置面板，适合需要精细控制 RAG 全流程的高级场景。

### 定位

RAG 节点 =   Embedding + 向量检索 + LLM 生成（完整管线）  

```text
用户问题
 ↓
Embedding（可独立指定 Embedding 模型）
 ↓
向量搜索（pgvector，可指定检索策略）
 ↓
Top K Chunks（可指定 Top K、相似度阈值）
 ↓
拼接 Context
 ↓
LLM 生成（可独立指定生成模型、Prompt、Temperature 等）
 ↓
输出最终答案
```

### 配置项

```text
知识库配置：
  知识库（多选）：
    ├── 产品知识库
    ├── FAQ 知识库
    └── ...

检索配置：
  查询来源：{{input}}       （变量引用上游节点输出）
  Embedding 模型：text-embedding-v2（可独立选择，默认使用知识库绑定模型）
  Top K：5
  相似度阈值：0.7
  检索模式：hybrid / vector / keyword
  最大注入 Token：4096

生成配置：
  LLM 模型：deepseek-chat
  System Prompt：你是一名专业的知识库问答助手……
  User Prompt：基于以下检索内容回答用户问题……
  Temperature：0.7
  Max Tokens：4096
  Output Format
```

> 配置面板 UI 示例：
>
> ```
> ┌─────────────────────────────────┐
> │ RAG 知识问答                    │
> ├─────────────────────────────────┤
> │ ▼ 知识库                        │
> │ 知识库                          │
> │ [ 产品知识库 ▼ ]  +  添加      │
> │                                 │
> │ ▼ 检索配置                      │
> │ Embedding 模型                  │
> │ [ 默认 ▼ ]                      │
> │ 查询    {{input}}               │
> │ Top K   5                       │
> │ 相似度阈值  0.7                 │
> │ 检索模式  [hybrid ▼]            │
> │                                 │
> │ ▼ 生成配置                      │
> │ LLM 模型  [deepseek-chat ▼]     │
> │ System Prompt                   │
> │ ················                │
> │ Temperature  0.7                │
> └─────────────────────────────────┘
> ```

### 输入 / 输出



输入：

&#x20;从上游节点获取查询文本（如 `{{input}}`、`{{llm_1.output}}`）



输出：

&#x20;LLM 生成的最终答案文本（与普通 LLM 节点输出格式相同）

```json
{
  "output": "根据产品知识库，Excel 批量导入功能支持最多 5000 条数据……",
  "ragMeta": {
    "hitCount": 5,
    "contextTokens": 1820,
    "ragRetrievalMs": 85,
    "llmGenerationMs": 2140
  }
}
```

### 执行流程

```text
RAGNodeHandler.execute()
  ↓
解析 config（knowledgeBaseIds、query、embeddingModel、topK、threshold、searchMode、llmModel、prompt…）
  ↓
变量替换（query 中的 {{xxx}} 引用）
  ↓
Embedding（使用指定的 embeddingModel）
  ↓
调用 KnowledgeRetrievalService.search(kbIds, query, topK, threshold, mode)
  ↓
拼接检索结果为 Context（{{rag_context}}）
  ↓
拼接 System Prompt + Context + User Input
  ↓
调用 LLM 生成（使用指定的 llmModel + temperature）
  ↓
记录运行元数据（检索耗时、生成耗时、Token 用量）
  ↓
输出最终答案
```

### 典型编排示例



示例 1：RAG 独立使用（最简单的知识问答）



```text
Input
 ↓
RAG（产品知识库，默认配置）
 ↓
Output
```



示例 2：RAG + Condition（无知识时兜底）



```text
Input
 ↓
RAG（产品知识库）
 ↓
Condition（RAG 输出是否包含"暂未找到"？）
 ├── true → Output（"抱歉，暂无相关产品知识"）
 └── false → Output（RAG 生成的答案）
```

### 与 LLM 内置 RAG 的选择建议

| 维度               | LLM 内置 RAG（简单模式）              | RAG 独立节点（高级模式）                    |
| ---------------- | ----------------------------- | --------------------------------- |
|   学习成本           | 极低，在 LLM 节点勾选即可               | 中，需要理解独立配置面板                      |
|   Embedding 模型   | 自动使用知识库绑定模型                   | 可独立选择 Embedding 模型                |
|   检索参数           | 统一默认值（Top K=5, Threshold=0.7） | 精细可配（Top K、Threshold、模式、Token 上限） |
|   LLM 生成         | 复用 LLM 节点已配置的模型/Prompt        | 在 RAG 面板独立配置，与上游 LLM 解耦           |
|   适用场景           | 快速原型、简单问答                     | 精细调优 Embedding / 检索 / 生成各环节       |
|   共享底层           | KnowledgeRetrievalService     | KnowledgeRetrievalService         |
|   推荐用户           | 新手 / 简单场景                     | 高级用户 / 需要调优 RAG 管线                |

>   技术职责清晰划分：   RAG 节点是 all-in-one 的知识问答节点（Embedding → 检索 → LLM 生成都在里面完成），输出最终答案。LLM 内置 RAG 是同一条管线的简化封装——用默认参数替用户省去配置步骤，但底层调用完全一致。

***

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

***

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

***

## 5.7 Condition 节点

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

***

# 6. Workflow 编辑器

核心页面：

```text
┌────────────┬───────────────────────────────┬──────────────────────┐
│ 节点面板   │          Workflow Canvas      │ 属性面板（选中 LLM） │
│            │                               │                      │
│ Start      │      ┌───────┐               │ Node Config          │
│ LLM        │      │ Start │               │                      │
│ RAG  │      └───┬───┘               │ Base Config          │
│ Prompt     │          ↓                   │ ├─ Model             │
│ HTTP       │      ┌───────┐               │ ├─ Temperature       │
│ Condition  │      │  LLM  │               │ ├─ System Prompt     │
│            │      └───┬───┘               │ ├─ User Prompt       │
│            │          ↓                   │ ├─ Max Tokens        │
│            │      ┌────────┐              │ └─ Output Format     │
│            │      │ Output │              │                      │
│            │      └────────┘              │ ☑ Knowledge Base     │
│            │                              │  ├─ Enable RAG       │
│            │   （高级模式示例）            │  ├─ Add KB...        │
│            │   Input → RAG → Output    │  ├─ Top K            │
│            │                              │  └─ Threshold        │
└────────────┴───────────────────────────────┴──────────────────────┘
```

>   v1.3 双模式说明：  
>
> -   RAG 节点   作为独立节点出现在节点面板中（高级模式，精细控制检索流程）
> -   LLM 节点属性面板   中仍内置 "Knowledge Base" 配置区域（简单模式，快速启用 RAG）
> - 两种模式共享底层 KnowledgeRetrievalService

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

***

# 7. Workflow 数据结构

### 示例一：简单模式（LLM 内置知识库配置）

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
        "model": "deepseek-chat",
        "temperature": 0.7,
        "systemPrompt": "你是一名专业的企业知识问答助手。请基于以下检索内容回答：\n\n{{rag_context}}",
        "userPrompt": "{{input}}",
        "maxTokens": 4096,
        "enableRag": true,
        "knowledgeBaseIds": ["kb_001", "kb_002"],
        "topK": 5,
        "similarityThreshold": 0.7,
        "searchMode": "hybrid"
      }
    }
  ],
  "edges": [
    { "source": "start", "target": "llm_1" }
  ]
}
```

### 示例二：高级模式（独立 RAG 节点，完整管线）

```json
{
  "nodes": [
    {
      "id": "start",
      "type": "start",
      "config": {}
    },
    {
      "id": "rag_1",
      "type": "rag",
      "config": {
        "knowledgeBaseIds": ["kb_001", "kb_002"],
        "query": "{{input}}",
        "embeddingModel": "text-embedding-v2",
        "topK": 10,
        "similarityThreshold": 0.75,
        "searchMode": "hybrid",
        "maxContextTokens": 4096,
        "llmModel": "deepseek-chat",
        "systemPrompt": "你是一名专业的产品知识库问答助手。请基于以下检索到的内容准确回答用户问题。如果检索内容中没有相关信息，请坦诚说明。\n\n{{rag_context}}",
        "temperature": 0.5,
        "maxTokens": 2048
      }
    }
  ],
  "edges": [
    { "source": "start", "target": "rag_1" }
  ]
}
```

>   v1.4 双模式说明：   两种模式并存：
>
> -   简单模式：   `type: "llm"` 的 config 中含 `enableRag` + `knowledgeBaseIds` 等字段，LLM 内部自动调用检索 → 拼接上下文 → 调用生成（调用 KnowledgeRetrievalService）
> -   高级模式：   独立的 `type: "rag"` 节点，包含完整管线（Embedding → 检索 → LLM 生成），可独立配置 Embedding 模型、检索参数和生成参数，输出最终答案
>
> Workflow 引擎在执行时，会根据节点 `type` 分别路由到 `LLMNodeHandler` 或 `RAGNodeHandler`，但两者都依赖同一后端 KnowledgeRetrievalService。

Workflow 定义与 Workflow 执行记录必须分离。

### Workflow 可见性

Workflow 支持：

```text
PRIVATE
PUBLIC
```

- `PRIVATE`：仅 Workspace 成员可访问。
- `PUBLIC`：非成员可以查看；是否允许运行、复制等能力由后续权限策略控制。
- 公开 Workflow 的查看权限不能转换为原 Workflow 的编辑权限。
- 非成员复制 Workflow 后，应创建属于当前用户 Workspace 的独立 Workflow。

### Published Workflow

只有发布后的 Workflow 版本才能作为 Agent 的 Workflow Tool 被调用：

```text
Workflow
   ↓
Workflow Version
   ↓
Publish
   ↓
Published Version
   ↓
Agent Workflow Tool
```

Agent 不直接调用用户正在编辑的 Draft。

***

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

### 节点 Handler 路由（v1.4 更新）

Workflow 引擎根据节点 `type` 路由到对应的 Handler：

```text
Workflow Engine
  ↓
NodeDispatcher
  ├── start      → StartNodeHandler
  ├── input      → InputNodeHandler
  ├── output     → OutputNodeHandler
  ├── llm        → LLMNodeHandler       // 简单模式下内部调用 KnowledgeRetrievalService 做 RAG
  ├── rag        → RAGNodeHandler        // 高级模式：Embedding → 检索 → LLM 生成（完整管线）
  ├── prompt     → PromptNodeHandler
  ├── http       → HTTPNodeHandler
  ├── condition  → ConditionNodeHandler
```

### RAG 节点执行流程（v1.4 重写）

RAG 节点是是是完整 RAG 管线节点是是，内部集成 Embedding + 检索 + LLM 生成：

```text
RAGNodeHandler.execute()
  ↓
解析 config（knowledgeBaseIds、query、embeddingModel、topK、threshold、searchMode、llmModel、systemPrompt、temperature...）
  ↓
变量替换（query 中的 {{xxx}} 引用）
  ↓
Embedding（使用 config.embeddingModel，默认使用知识库绑定模型）
  ↓
调用 KnowledgeRetrievalService.search(kbIds, query, topK, threshold, mode)
  ↓
拼接检索结果为 Context（{{rag_context}}）
  ↓
拼接 System Prompt + Context + User Input
  ↓
调用 LLM 生成（使用 config.llmModel + config.temperature）
  ↓
记录运行元数据（retrievalMs、llmGenerationMs、hitCount、contextTokens、token 用量）
  ↓
输出最终答案文本
```

### LLM 节点（简单模式）内嵌 RAG 执行流程（v1.3 补充）

```text
LLMNodeHandler.execute()
  ↓
检查 config.enableRag
  ├── false → 直接调用 AIProvider.chat()
  └── true  → KnowledgeRetrievalService.search(...)
                ↓
              拼接 {{rag_context}} 注入 System Prompt
                ↓
              调用 AIProvider.chat(enhancedPrompt)
```

***

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

***

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

***

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

***

# 12. AI Agent

Agent 是平台的上层智能应用能力，不是第一阶段 Workflow 的核心依赖。

Agent 的核心职责：

>   根据用户需求进行理解、决策，并选择和调用已经配置好的工具能力，最终生成面向用户的结果。  

### Agent 可以调用的能力

```text
Workflow Tool
Knowledge Tool
HTTP Tool
Database Tool
Search Tool
Calculator Tool
```

其中：

- `Workflow Tool`：调用 Workspace 中已经发布的 Workflow。
- `Knowledge Tool`：调用 Agent 被授权使用的 Knowledge Base。
- 其他 Tool 按后续阶段逐步实现。

### Agent 与 Workflow 的关系

```text
用户
 ↓
Agent
 ↓
判断用户需求
 ↓
选择 Workflow Tool
 ↓
调用已发布 Workflow
 ↓
获得 Workflow Result
 ↓
Agent 继续处理
 ↓
最终输出
```

Workflow 是“怎么做”，Agent 是“根据需求决定做什么以及调用什么”。

### Agent 与 Knowledge Base 的关系

Knowledge Base 独立管理：

```text
Workspace
 └── Knowledge Base
      ├── Documents
      └── Chunks / Embeddings
```

Agent 只有在被明确配置 / 授权后，才能调用对应 Knowledge Base。

建议使用独立关系：

```text
Agent
  │
  └── AgentKnowledgeBase
          ↓
    Knowledge Base
```

### Agent 与 Workflow 的授权关系

Agent 可以配置允许调用的 Workflow：

```text
Agent
  │
  └── AgentWorkflow
          ↓
      Workflow
```

`AgentWorkflow` 建议保存：

```text
agentId
workflowId
toolName
description
enabled
```

同一个 Agent 与 Workflow 不允许重复绑定。

### Agent 示例

用户：

```text
分析本月销售数据，并生成一份销售分析报告。
```

Agent：

```text
1. 判断需要销售数据
2. 调用“销售数据分析 Workflow”
3. 获得 Workflow Result
4. 调用“公司销售知识库”
5. 综合分析
6. 生成最终报告
```

注意：这里的“报告”是 Agent 的一种输出结果，而不是 Workflow 中必须存在的 Report Node。

***

# 13. Agent 输出与报告功能

AI 报告不作为 Workspace 下与 Workflow、Knowledge Base、Agent 并列的核心资源。

报告定位为：

>   Agent 在特定业务场景下生成的一种结构化输出 / 可交付结果。  

Agent 可以根据任务输出：

```text
普通文本
JSON
Markdown
表格
报告
```

例如：

```text
用户需求
 ↓
Agent
 ↓
调用 Workflow
 ↓
调用 Knowledge Base
 ↓
LLM 分析
 ↓
生成结构化报告
```

报告可以包含：

- 标题
- 摘要
- 段落
- 表格
- 图片
- 图表
- AI 内容

如果需要进一步编辑，可以进入 Report Editor。

报告编辑器建议使用：



CKEditor 5



支持：

- 富文本编辑
- 加粗
- 斜体
- 标题
- 列表
- 表格
- 图片
- AI 改写

### 报告生成原则

Agent 生成报告时，优先使用 Structured Output：

```json
{
  "title": "2026年9月销售分析报告",
  "summary": "...",
  "analysis": [
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

再由报告渲染 / 编辑层转换为最终展示内容。

### 报告不是 Workflow 的必要节点

Workflow 的职责是执行能力，例如：

```text
Start
 ↓
Input
 ↓
RAG
 ↓
LLM
 ↓
Output
```

而不是：

```text
Start
 ↓
Input
 ↓
RAG
 ↓
LLM
 ↓
Report Node
```

Workflow 可以产生结构化数据，Agent 再将这些数据加工为报告。

### 报告导出

报告属于可选应用功能，可支持：

```text
Agent 输出报告
 ↓
Report Editor
 ↓
用户修改
 ↓
PDF / Word
```

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



CKEditor 5



支持：

- 富文本编辑
- 加粗
- 斜体
- 标题
- 列表
- 表格
- 图片
- AI 改写

***

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
visibility       // PRIVATE / PUBLIC
createdAt
updatedAt
```

## Workspace Member

```text
workspaceId
userId
roleId
createdAt
```

### Friendship

好友关系与 Workspace 成员关系分离。

```text
id
userId
friendId
status          // PENDING / ACCEPTED / REJECTED / BLOCKED
createdAt
updatedAt
```

规则：

```text
Friendship
   ↓
允许发送 Workspace 邀请
```

而不是：

```text
Friendship
   ↓
自动获得 Workspace 权限
```

### Workspace Invitation

建议增加 Workspace 邀请关系：

```text
id
workspaceId
inviterId
inviteeId
status          // PENDING / ACCEPTED / REJECTED / EXPIRED
createdAt
updatedAt
```

只有邀请被接受后，才创建或激活 `WorkspaceMember`。

### Workflow

```text
id
workspaceId
name
description
visibility       // PRIVATE / PUBLIC
status           // DRAFT / PUBLISHED / ARCHIVED
createdBy
createdAt
updatedAt
```

***

# 16. RBAC 权限

角色：

当前产品阶段建议：

```text
Owner
Member
```

- `Owner`：Workspace 所有者，负责 Workspace 管理、成员邀请、公开设置等。
- `Member`：被邀请并接受后加入 Workspace 的协作者，默认可以查看、编辑和运行 Workspace 内 Workflow。

后续如果需要更细粒度权限，再扩展：

```text
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
workflow:publish
workflow:copy

knowledge:create
knowledge:read
knowledge:update
knowledge:delete

agent:create
agent:read
agent:update
agent:delete
agent:run

report:create
report:read
report:edit
report:export

workspace:invite
workspace:member:read
workspace:settings:update
```

说明：

- Workspace 成员的默认协作权限由当前产品阶段定义。
- 后端必须根据 WorkspaceMember / Role 进行最终权限校验。
- 公开 Workspace / Workflow 的访问权限不能替代成员权限。

后端必须进行最终权限校验。

前端权限只用于 UI 展示控制，不能作为安全边界。

***

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

friendships
workspace_invitations

agents
agent_workflows
agent_knowledge_bases

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

### workflow\_node\_runs 扩展元数据（v1.3 补充）

`workflow_node_runs` 表除通用字段（`input` / `output` / `duration` / `error`）外，`output` JSON 字段需能承载不同节点类型的特有元数据：



RAG 节点特有的运行元数据：



```json
{
  "knowledgeBaseIds": ["kb_001", "kb_002"],
  "hitCount": 12,
  "documentCount": 5,
  "scoreRange": { "min": 0.72, "max": 0.95 },
  "ragRetrievalMs": 120,
  "documents": [ ... ]
}
```



LLM 节点（启用 RAG 时）特有的运行元数据：



```json
{
  "ragEnabled": true,
  "ragKnowledgeBaseIds": ["kb_001"],
  "ragHitCount": 8,
  "ragContextTokens": 1820,
  "ragRetrievalMs": 85,
  "llmGenerationMs": 2140,
  "inputTokens": 2300,
  "outputTokens": 450
}
```

> 设计原则：不为每种节点类型创建单独的运行表，而是通过 `output` JSON 字段的弹性结构承载节点特有元数据。前端根据 `node.type` 动态渲染不同的运行详情面板。

***

# 18. API 设计原则

RESTful API：

```text
/api/auth
/api/users
/api/friendships
/api/workspaces
/api/workspaces/:workspaceId/members
/api/workspaces/:workspaceId/invitations
/api/workflows
/api/workflow-runs
/api/knowledge-bases
/api/documents
/api/agents
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

POST /api/workspaces/:workspaceId/invitations
GET /api/workspaces/:workspaceId/members
POST /api/agents
POST /api/agents/:id/run
```

***

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

### HTTP Node

需要防止 SSRF。

### 文件上传

需要：

- 类型检查
- 大小限制
- 文件名处理
- 病毒 / 恶意文件检查（生产环境）
- 对象存储隔离

### 知识库引用权限校验（v1.3 补充）

当 Workflow 中的 LLM 节点（简单模式）或 RAG 节点（高级模式）引用 `knowledgeBaseIds` 时，后端必须在在在两个时机在在校验权限：

1.   保存 Workflow 时  （静态校验）
   - 检查被引用的 Knowledge Base 是否属于当前 Workspace 或被授权访问
   - 拒绝引用不存在 / 无权限的 Knowledge Base，前端给出明确提示
2.   执行 Workflow 时  （动态校验）
   - 再次校验执行时的权限有效性（防止 Workflow 保存后 Knowledge Base 被删除或权限被撤销）
   - 校验失败则节点标记 FAILED，不执行检索

```text
Workflow 执行 LLM/RAG 节点
  ↓
KnowledgeAccessGuard.check(workspaceId, knowledgeBaseIds)
  ├── 全部通过 → 继续执行
  └── 任一失败 → NodeResult.status = FAILED, error = "无权限访问知识库 X"
```

> 当前阶段 Knowledge Base 固定归属于同一 Workspace 内，但设计上已预留跨 Workspace 引用的权限校验入口。

***

# 20. 前端目录建议

```text
src/
├── api/
│   ├── auth.ts
│   ├── workspace.ts
│   ├── workflow.ts
│   ├── knowledge.ts
│   ├── agent.ts
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
│   ├── workspace/
│   ├── workflow/
│   ├── knowledge/
│   ├── agent/
│   └── settings/
│
├── stores/
├── router/
├── types/
├── utils/
├── hooks/
└── main.ts
```

***

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
│   ├── nodes/
│       ├── start.node.ts
│       ├── llm.node.ts           // LLM 节点（简单模式下内部调用 KnowledgeRetrievalService）
│       ├── rag.node.ts         // RAG 独立节点（高级模式）
│       ├── prompt.node.ts
│       ├── http.node.ts
│       ├── condition.node.ts
│
├── ai/
│   ├── providers/
│   ├── ai.service.ts
│   └── ai.module.ts
│
├── knowledge/
│   ├── knowledge.service.ts
│   ├── knowledge-retrieval.service.ts  // ⭐ 共享检索服务（被 LLM Node / RAG 节点 / Agent 共同调用）
│   ├── knowledge.controller.ts
│   └── knowledge.module.ts
├── documents/
├── embeddings/
├── agents/
├── reports/
├── files/
├── queue/
├── redis/
├── prisma/
├── common/
└── main.ts
```

***

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
-   KnowledgeRetrievalService 共享检索服务  （被 LLM Node / RAG 节点 / Agent 复用）
-   LLM 节点内置 RAG 配置（简单模式：enableRag + knowledgeBaseIds + topK + threshold）  
-   RAG 独立节点（高级模式：独立 RAG 节点、输出最终答案）  
-   前端 LLM 属性面板的知识库配置 UI + RAG 节点的属性面板 UI  

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

## Phase 7：报告能力

完成：

- Agent 报告输出
- Report Template
- CKEditor 5
- Report Version
- PDF
- Word

报告作为 Agent 的一种应用输出能力，不作为 Workflow 必选节点。

***

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

***

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
Agent Report
Report Template
CKEditor 5
PDF
Word
```

***

# 24. 核心产品模型与用户流程

## 24.1 核心产品关系

```text
User
 │
 ├── Friendship ─────────────── Friend
 │
 └── Workspace
       │
       ├── WorkspaceMember
       │
       ├── Workflow
       │     └── WorkflowVersion
       │           │
       │           │ (Workflow 内部节点可通过两种方式使用知识)
       │           │
       │     ┌─────┴────────────┐
       │     ↓                  ↓
       │  LLM Node          RAG 节点
       │  (简单模式)         (高级模式)
       │     │                  │
       │     └────────┬─────────┘
       │              ↓
       │   KnowledgeRetrievalService（共享）
       │              ↓
       ├── Knowledge Base ←──┘
       │     └── Documents / Chunks
       │
       └── Agent
             ├── AgentWorkflow
             │      └── Published Workflow
             │
             └── AgentKnowledgeBase
                    └── Knowledge Base（通过 KnowledgeRetrievalService 调用）
```

## 24.2 三个核心概念

```text
Workflow      = 怎么做（流程编排 + 节点执行）
Knowledge Base = 知道什么（知识数据存储 + 索引）
Agent         = 根据需求决定调用什么
```

### Workflow

负责确定性流程执行、测试、保存、发布。

- RAG 能力以以以双模式以以存在于 Workflow 中：简单模式（LLM 内置配置）和高级模式（独立 RAG 节点）

### Knowledge Base

负责知识存储、文档解析、Embedding、向量索引和检索。

- 自身不是 Workflow 节点类型，而是 Workflow 节点（LLM / RAG）可引用的数据源

### Agent

负责理解用户需求、选择工具、调用 Workflow / Knowledge Base，并组织最终输出。

- Agent 调用 Knowledge Base 也通过同一 KnowledgeRetrievalService

### Report

不是第四个核心概念，而是 Agent 的一种应用输出能力。

## 24.3 用户进入 Workspace 的页面流程

```text
工作台
 ↓
点击 Workspace
 ↓
Workspace 首页
 ↓
Workflow 列表
 ↓
点击 Workflow
 ↓
Workflow Editor
```

Workspace 首页后续可以扩展：

```text
Workflow
Knowledge Base
Agent
Members
Settings
```

## 24.4 用户查看其他用户 Workspace

```text
用户主页
 ↓
查看公开 Workspace
 ↓
查看公开 Workflow
 ↓
查看 / 运行 / 复制（按公开策略）
```

未被邀请进入 Workspace 的用户：

- 不是 WorkspaceMember
- 不能编辑原 Workflow
- 不能访问私有 Workflow
- 可以复制允许复制的公开 Workflow 到自己的 Workspace

好友用户：

- 可以被邀请进入 Workspace
- 接受邀请后成为 WorkspaceMember
- 不因为“好友”身份自动获得 Workspace 权限

## 24.5 协作原则

```text
好友
  ≠
Workspace 成员
  ≠
Workflow 编辑权限
```

正确关系：

```text
好友
 ↓
可以发起 Workspace 邀请
 ↓
接受邀请
 ↓
WorkspaceMember
 ↓
获得 Workspace 协作权限
```

## 24.6 Agent 调用 Workflow

Agent 只能调用已经发布的 Workflow：

```text
Workflow Draft
    ↓
测试
    ↓
Publish
    ↓
Published Version
    ↓
AgentWorkflow
    ↓
Agent Tool Calling
```

这样可以避免 Agent 调用用户尚未完成的 Draft。

## 24.7 报告应用流程

```text
用户
 ↓
Agent
 ↓
Workflow Tool
 ↓
Workflow Result
 ↓
Knowledge Tool（可选）
 ↓
LLM
 ↓
Report Output
 ↓
Report Editor（可选）
 ↓
PDF / Word（可选）
```

报告属于应用层结果，不改变 Workflow 的核心定位。

***

# 25. 开发约束

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

***

# 26. 后续与 AI 助手协作规则

以后将本文档提供给 AI 助手时，应将其视为：

>   AI WorkFlow Studio 的项目上下文和技术基线。  

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

***

# 27. 后续开发方式

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
4. Workspace Member / Invitation
5. Friendship / 用户主页 / 公开 Workspace
6. Workflow CRUD
7. Workflow List
8. Workflow Canvas
9. Workflow Engine
10. AI Provider
11. LLM Node
12. SSE
13. Knowledge Base（独立管理）
14. KnowledgeRetrievalService（共享检索服务）
15. LLM 节点内置 RAG 配置（简单模式）
16. RAG 独立节点（高级模式）
17. Advanced Nodes
18. Workflow Publish / Version
19. Agent
20. Agent Workflow Tool
21. Agent Knowledge Tool
22. Agent Run / Streaming
23. Agent Report
24. Report Editor / PDF / Word
25. Deployment
```

***

# 28. 项目最终目标

最终形成一个以 Workflow + Knowledge Base + Agent 为核心的 AI SaaS 平台，产品理念参考：

```text
Dify
+
n8n
+
AI 应用 / 报告能力
```

但不将“AI Report”作为与 Workflow、Knowledge Base、Agent 并列的核心资源。

核心差异不是简单复制这些产品，而是通过项目学习并实现：

- 全栈架构
- 可视化 Workflow
- AI Provider 抽象
- LLM
- RAG（双模式：LLM 内置 + 独立 RAG 节点，共享 KnowledgeRetrievalService）
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

>   这是一个可以真实运行的 AI SaaS，而不是一个单纯展示 AI Chat 的 Demo。  

