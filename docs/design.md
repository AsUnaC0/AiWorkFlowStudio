# AI WorkFlow Studio — 前端页面设计文档

## 页面总览

### 路由表

| 路径 | 页面 | 是否经过 MainLayout | 状态 |
|------|------|---------------------|------|
| `/login` | 登录 / 注册 |  独立全屏 | 
| `/chat` | AI 聊天 | 
| `/workflow` | 工作空间（Workspace + 工作流列表） |
| `/workflow/:id` | 工作流编辑器 
| `/knowledge` | 知识库列表 | ✅ | ✅ 已实现 |
| `/knowledge/:kbId` | 知识库详情（文档管理） | ✅ | ✅ 已实现 |
| `/report` | AI 报告 | ✅ | 🔲 占位 |

### 页面导航链路

```
登录 → MainLayout
  ├── AI 聊天 (默认首页，redirect 目标)
  ├── 工作空间
  │     ├── (无 workspaceId) → Workspace 卡片网格
  │     │     └── 点击 Workspace
  │     └── (有 workspaceId) → 工作流卡片网格
  │           └── 点击 Workflow → 工作流编辑器 (/workflow/:id, 独立全屏)
  ├── 知识库列表
  │     └── 点击知识库 → 知识库详情 (/knowledge/:kbId)
  └── 报告 (开发中)
```

---

## 1. 登录页 `/login`

**路由**: 独立全屏路由，`meta.public = true`
**组件**: `fronted/src/views/login/index.vue`

### 页面用途

用户身份认证入口，支持新用户注册和已有用户登录。

### 展示数据

| 区域 | 展示内容 | 数据来源 |
|------|----------|----------|
| 品牌区 | Logo 文字 "AWS"、标题 "AI WorkFlow Studio"、副标题 "让每个想法，流动起来" | 静态 |
| 表单区 | 用户名（仅注册时显示）、邮箱、密码 | 用户输入 → `POST /api/auth/login` 或 `POST /api/auth/register` |
| 错误提示 | 登录/注册失败信息 | 后端响应 `message` 字段 |

### 布局结构

```
┌─────────────────────────────────────────────────┐
│  背景渐变（浅灰 → 淡蓝）                            │
│                                                 │
│          ┌─────────────────────────┐            │
│          │        Brand Logo       │            │
│          │    AI WorkFlow Studio   │            │
│          │   让每个想法，流动起来     │            │
│          ├─────────────────────────┤            │
│          │   [登录]    [注册]      │            │
│          ├─────────────────────────┤            │
│          │  用户名       [仅注册]    │            │
│          │  ┌─────────────────┐    │            │
│          │  │ name@example.com│    │            │
│          │  └─────────────────┘    │            │
│          │  密码                     │            │
│          │  ┌─────────────────┐    │            │
│          │  │  ••••••••        │    │            │
│          │  └─────────────────┘    │            │
│          │                         │            │
│          │  ┌─────────────────┐    │            │
│          │  │  进入工作台       │    │            │
│          │  └─────────────────┘    │            │
│          └─────────────────────────┘            │
│                                                 │
└─────────────────────────────────────────────────┘
```

---

## 2. 主布局 MainLayout

**组件**: `fronted/src/layout/MainLayout.vue`
**包裹页面**: `/chat`, `/workflow`, `/knowledge`, `/knowledge/:kbId`, `/report`

### 布局结构

```
┌────────┬──────────────────────────────────────────┐
│ 左侧栏  │  顶部导航栏                                │
│ 220px  │ ┌────────────────────────────────────┐   │
│ (可折叠 │ │ ☰  AI WorkFlow Studio      用户 ▼ │   │
│  64px) │ └────────────────────────────────────┘   │
│        │                                          │
│ ┌────┐ │  ┌──────────────────────────────────┐    │
│ │ AI │ │  │                                  │    │
│ │ Work│ │  │         <router-view />          │    │
│ │Flow│ │  │                                  │    │
│ ├────┤ │  │                                  │    │
│ │📋 │ │  └──────────────────────────────────┘    │
│ │聊天 │ │                                          │
│ ├────┤ │                                          │
│ │📁 │ │                                          │
│ │工作 │ │                                          │
│ │空间 │ │                                          │
│ ├────┤ │                                          │
│ │📚 │ │                                          │
│ │知识 │ │                                          │
│ │库   │ │                                          │
│ └────┘ │                                          │
└────────┴──────────────────────────────────────────┘
```

### 数据来源

| 区域 | 展示内容 | 数据来源 |
|------|----------|----------|
| 侧边栏 Logo | 完整时 "AI WorkFlow"，折叠时 "AI" | 静态 |
| 菜单项 | AI 聊天、工作空间、知识库 | 静态菜单，点击路由跳转 |
| 顶部用户 | 当前登录用户名 | `userStore.userInfo.username` |
| 用户下拉 | 退出登录 | 点击调用 `userStore.logout()` → 跳转 `/login` |

---

## 3. AI 聊天页 `/chat`

**组件**: `fronted/src/views/chat/index.vue`

### 页面用途

面向用户的 AI 对话界面。支持选择 AI 模型、关联知识库进行 RAG 问答、未来支持关联工作流（Agent 模式）。

### 布局结构（双栏）

```
┌──────────────┬──────────────────────────────────────────┐
│ 左侧配置面板  │  中间聊天区域                                │
│  280px       │  ┌────────────────────────────────────┐  │
│              │  │  AI 助手    使用 qwen2.5:7b 对话 │  │
│ ┌──────────┐ │  ├────────────────────────────────────┤  │
│ │ AI 模型   │ │  │                                  │  │
│ │ [选择 ▼] │ │  │   🤖 空状态 / 💡 建议问题 / ... │  │
│ └──────────┘ │  │                                  │  │
│              │  │   消息气泡列表（用户右 / AI 左）     │  │
│ ┌──────────┐ │  │                                  │  │
│ │ 知识库   │ │  │                                  │  │
│ │ [多选 ▼] │ │  ├────────────────────────────────────┤  │
│ │ 3 文档 · │ │  │ ┌────────────────────────────────┐ │  │
│ │ nomic..  │ │  │ │ 输入框（Enter 发送 / Shift+换行）│ │  │
│ └──────────┘ │  │ └────────────────────────────────┘ │  │
│              │  │ 📚 已选 1 知识库                    │  │
│ ┌──────────┐ │  └────────────────────────────────────┘  │
│ │ 工作流   │ │                                          │
│ │ [多选 ▼] │ │                                          │
│ │ (开发中)  │ │                                          │
│ └──────────┘ │                                          │
│              │                                          │
│ ─────────── │                                          │
│ 🗑 清空对话  │                                          │
└──────────────┴──────────────────────────────────────────┘
```

### 展示数据

| 区域 | 展示内容 | 数据来源 |
|------|----------|----------|
| AI 模型选择 | 可用模型列表 | `GET /api/ai/models`（Ollama API，失败时回退默认值） |
| 知识库多选 | 知识库名称 + 文档数 + embedding 模型 | `GET /api/knowledge-bases` → `KnowledgeBase[]` |
| 工作流多选 | 工作流名称（当前 disabled） | `GET /api/workflows?workspaceId=xxx` |
| 聊天消息 | role、content、time | 本地状态，API: `POST /api/ai/chat` |
| 发送中指示器 | 三点跳动动画 | `sending` ref 状态 |

### 数据模型

```
KnowledgeBase {
  id, name, description?, embeddingModel, embeddingDimension,
  documentCount, chunkCount, createdAt, updatedAt
}

ChatMessage { role: 'user' | 'assistant', content: string }
```

---

## 4. 工作空间页 `/workflow`

**组件**: `fronted/src/views/workflow/list.vue`

### 页面用途

两层视图：Workspace 选择视图 → 工作流列表视图。Workspace 是资源容器，工作流是 Workspace 下可独立创建和编辑的能力单元。

---

#### 视图 A：Workspace 选择（无 `workspaceId` query）

**触发条件**: 访问 `/workflow` 不带 query 参数

**布局结构**

```
┌─────────────────────────────────────────────────────────┐
│ 工作空间                              [+ 创建 Workspace] │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ ┌───────────────┐  ┌───────────────┐  ┌───────────────┐ │
│ │ 📁 Marketing  │  │ 📁 Product    │  │ 📁 R&D         │ │
│ │               │  │               │  │               │ │
│ │   5 Workflow  │  │   3 Workflow  │  │   0 Workflow  │ │
│ │   2 知识库     │  │   1 知识库     │  │   0 知识库     │ │
│ │   0 AI 报告    │  │   5 AI 报告    │  │   0 AI 报告    │ │
│ │   3 名成员     │  │   2 名成员     │  │   1 名成员     │ │
│ └───────────────┘  └───────────────┘  └───────────────┘ │
│                                                          │
│ 空状态：还没有 Workspace → [创建 Workspace]              │
└─────────────────────────────────────────────────────────┘
```

**展示数据**

| 字段 | 说明 | 来源 |
|------|------|------|
| `ws.id` | Workspace 主键 | `Workspace.id` |
| `ws.name` | Workspace 名称 | `Workspace.name` |
| `ws.icon` | 图标 emoji，默认 "📁" | 前端静态 |
| `ws.workflowCount` | 该 Workspace 下工作流数量 | 后端统计或 `Workflow[].length` |
| `ws.knowledgeCount` | 该 Workspace 下知识库数量 | 后端统计 |
| `ws.reportCount` | AI 报告数量 | 后端统计 |
| `ws.memberCount` | 成员数量 | `WorkspaceMember[].length` |

**API**: `GET /api/workspaces`

---

#### 视图 B：工作流列表（有 `workspaceId` query）

**触发条件**: 访问 `/workflow?workspaceId=xxx`

**布局结构**

```
┌─────────────────────────────────────────────────────────┐
│ ← 返回    工作空间                [+ 创建工作流]        │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ ┌────────────────────┐  ┌────────────────────┐         │
│ │ WF-001 销售数据分析 │  │ WF-002 产品知识库问答 │         │
│ │                    │  │                    │         │
│ │ 创建于 2026-09-20  │  │ 创建于 2026-09-22  │         │
│ │ 更新于 2026-09-23  │  │ 更新于 2026-09-24  │         │
│ └────────────────────┘  └────────────────────┘         │
│                                                          │
│ 空状态：还没有工作流 → [创建工作流]                      │
└─────────────────────────────────────────────────────────┘
```

**展示数据**

| 字段 | 说明 | 来源 |
|------|------|------|
| `wf.id` | 工作流主键 | `Workflow.id` |
| `wf.name` | 工作流名称 | `Workflow.name` |
| `wf.createdAt` | 创建时间 | `Workflow.createdAt` |
| `wf.updatedAt` | 更新时间 | `Workflow.updatedAt` |

**API**: `GET /api/workflows?workspaceId=xxx`

---

## 5. 工作流编辑器 `/workflow/:id`

**路由**: 独立全屏路由，不经过 MainLayout（`meta.standalone = true`）
**组件**: `fronted/src/views/workflow/index.vue`

### 页面用途

可视化工作流编辑器。拖拽节点到画布、连线、配置节点属性、测试运行工作流。

### 布局结构（三栏）

```
┌─────────────────────────────────────────────────────────┐
│ ← 返回  工作流名称  正在加载...  [保存]  [运行]          │
├──────────┬──────────────────────────────┬───────────────┤
│ 节点面板  │        VueFlow 画布          │   属性面板     │
│  240px   │                               │    280px      │
│          │      ┌─────────┐              │               │
│ ▼ Start  │      │  Start  │              │ ─── LLM 配置 ─── │
│ ▼ Input  │      └────┬────┘              │               │
│ ▼ LLM    │           ↓                   │ Model          │
│ ▼ Prompt │      ┌─────────┐              │ [qwen2.5:7b ▼] │
│ ▼ RAG    │      │   LLM   │              │               │
│ ▼ HTTP   │      └────┬────┘              │ Temperature    │
│ ▼ Cond   │           ↓                   │ ────●────────  │
│ ▼ Output │      ┌─────────┐              │               │
│          │      │ Output  │              │ Prompt         │
│          │      └─────────┘              │ ┌───────────┐ │
│          │                               │ │           │ │
│          │   [背景网格 + Controls 缩放]   │ └───────────┘ │
└──────────┴──────────────────────────────┴───────────────┘
```

### 展示数据

#### 左侧节点面板（可拖拽）

| 节点 | type | 用途 |
|------|------|------|
| Start | `start` | 工作流入口 |
| Input | `input` | 接收用户输入 |
| LLM | `llm` | 大语言模型生成（支持内置 RAG 简单模式） |
| Prompt | `prompt` | 可复用 Prompt 模板 |
| RAG | `rag` | 独立 RAG 节点（Embedding → 检索 → LLM，高级模式） |
| HTTP | `http` | 调用第三方 API |
| Condition | `condition` | 条件分支 |
| Output | `output` | 向用户输出结果 |

#### 中间画布

由 `VueFlow` 渲染，数据结构：

```typescript
interface WorkflowDefinition {
  nodes: FlowNode[];  // 含 position, type, data(nodeType, label, config...)
  edges: FlowEdge[];  // { source, target }
}
```

#### 右侧属性面板（选中节点时显示）

**通用字段**（所有节点类型）

| 字段 | 说明 | 类型 |
|------|------|------|
| Node ID | 节点主键，不可编辑 | disabled input |
| Node Type | 节点类型，不可编辑 | disabled input |
| Label | 显示标签 | text input |

**LLM 节点专属配置**

| 字段 | 说明 | 控件 |
|------|------|------|
| Model | 模型名称 | select |
| Temperature | 0~1 | range slider |
| Prompt | 提示词模板（支持 `{{变量}}`） | textarea |

**Prompt 节点专属配置**

| 字段 | 说明 | 控件 |
|------|------|------|
| Prompt | Prompt 模板内容 | textarea |

**RAG 节点专属配置**

| 字段 | 说明 | 控件 | 数据来源 |
|------|------|------|----------|
| 知识库（可多选） | 关联的 KnowledgeBase | t-select multiple | `GET /api/knowledge-bases` |
| 检索模式 | hybrid / vector / keyword | select | — |
| Top K | 1~20，默认 5 | range slider | — |
| 距离阈值 | 0.1~1.5，默认 0.8 | range slider（keyword 模式隐藏） | — |
| Embedding 模型 | 向量模型名称 | text input | — |

#### 运行对话框

点击"运行"按钮弹出：

```
┌──────────────────────────────────┐
│ 运行工作流                    ✕  │
├──────────────────────────────────┤
│ 输入内容                          │
│ ┌──────────────────────────────┐ │
│ │ 请输入本次运行传给工作流的内容 │ │
│ │                              │ │
│ └──────────────────────────────┘ │
│                                  │
│ ▸ 正在运行：llm                  │
│                                  │
│ ┌──────────────────────────────┐ │
│ │ 你                           │ │
│ │ 分析这份产品文档...           │ │
│ ├──────────────────────────────┤ │
│ │ 工作流                        │ │
│ │ 正在为你分析产品文档内容...   │ │
│ └──────────────────────────────┘ │
│                                  │
│          [取消]    [运行]        │
└──────────────────────────────────┘
```

**运行时数据事件**（SSE/流式）：

| 事件类型 | 说明 | 展示 |
|----------|------|------|
| `node:start` | 节点开始执行 | "正在运行：XXX" |
| `token` | LLM 流式输出 token | 实时追加到助手气泡 |
| `node:complete` | 节点执行完成 | "已完成：XXX" |
| `complete` | 整个工作流完成 | JSON 运行结果 |

**API**: `POST /api/workflows/:id/run`（流式 SSE）

---

## 6. 知识库列表页 `/knowledge`

**组件**: `fronted/src/views/knowledge/index.vue`

### 页面用途

展示当前用户的所有知识库，支持创建、进入详情、删除操作。

### 布局结构

```
┌─────────────────────────────────────────────────────────┐
│ 知识库                              [+ 创建知识库]       │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ ┌──────────────────┐  ┌──────────────────┐              │
│ │ 📚 产品知识库     │  │ 📚 企业制度知识库 │              │
│ │                  │  │                  │              │
│ │ 暂无描述 / 描述   │  │ 员工手册、考勤... │              │
│ │                  │  │                  │              │
│ │ 5 文档  128 分块  │  │ 3 文档   86 分块  │              │
│ │ nomic-embed-text │  │ nomic-embed-text │              │
│ │     @768          │  │     @768          │              │
│ ├──────────────────┤  ├──────────────────┤              │
│ │ 更新于 09-24 10:00 │  │ 更新于 09-23 15:30 │              │
│ │ [进入管理] [删除] │  │ [进入管理] [删除] │              │
│ └──────────────────┘  └──────────────────┘              │
│                                                          │
│ 空状态：还没有知识库 → [创建知识库]                      │
└─────────────────────────────────────────────────────────┘
```

### 展示数据

| 字段 | 说明 | 来源 |
|------|------|------|
| `kb.name` | 知识库名称 | `KnowledgeBase.name` |
| `kb.description` | 描述（可为空） | `KnowledgeBase.description` |
| `kb.documentCount` | 文档数量 | `KnowledgeBase.documentCount` |
| `kb.chunkCount` | 向量分块数量 | `KnowledgeBase.chunkCount` |
| `kb.embeddingModel` | Embedding 模型名称 | `KnowledgeBase.embeddingModel` |
| `kb.embeddingDimension` | 向量维度 | `KnowledgeBase.embeddingDimension` |
| `kb.updatedAt` | 最近更新时间 | `KnowledgeBase.updatedAt` |

### 数据模型

```
KnowledgeBase {
  id               String
  name             String
  description      String?
  embeddingModel   String
  embeddingDimension Int
  documentCount    Int
  chunkCount       Int
  ownerId          String  (关联 User)
  workspaces       WorkspaceKnowledgeBase[]  (多对多)
  documents        Document[]
}
```

**API**:
- `GET /api/knowledge-bases` — 列表
- `POST /api/knowledge-bases` — 创建（name, description?, embeddingModel, embeddingDimension）
- `DELETE /api/knowledge-bases/:id` — 删除

---

## 7. 知识库详情页 `/knowledge/:kbId`

**组件**: `fronted/src/views/knowledge/detail.vue`

### 页面用途

查看知识库概览信息，管理知识库内的文档（上传、查看状态、删除）。

### 布局结构

```
┌─────────────────────────────────────────────────────────┐
│ ← 返回知识库列表   / 知识库   / 产品知识库               │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ 📚 产品知识库        │  5 文档 │ 128 分块 │ nomic-embed-text │ 768 │ │
│ │ 员工手册、产品文档... │          │          │                  │     │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                          │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ 文档列表 (5)                        [↑ 上传文档]     │ │
│ │                                                     │ │
│ │ ┌──────────┬────────┬──────┬──────────┬─────────┬───┤ │
│ │ │ 文件名    │ 状态    │ 页数  │ 错误信息  │ 上传时间 │操作│ │
│ │ ├──────────┼────────┼──────┼──────────┼─────────┼───┤ │
│ │ │ 📕员工手册│ 处理中  │  24  │          │ 09-23   │ 🗑 │ │
│ │ │ .pdf     │ ██████ │      │          │ 10:00   │   │ │
│ │ ├──────────┼────────┼──────┼──────────┼─────────┼───┤ │
│ │ │ 📄FAQ.md │ ✅ 完成 │   -  │          │ 09-22   │ 🗑 │ │
│ │ ├──────────┼────────┼──────┼──────────┼─────────┼───┤ │
│ │ │ 📘产品.docx│ ❌ 失败│  12  │解析失败...│ 09-21   │ 🗑 │ │
│ │ └──────────┴────────┴──────┴──────────┴─────────┴───┘ │
│                                                     │
│ │ 🕐 文档正在后台解析中，页面将自动刷新状态...          │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### 展示数据

#### 概览卡片

| 字段 | 说明 | 来源 |
|------|------|------|
| 知识库名称 | 大标题 | `KnowledgeBase.name` |
| 描述 | 副标题 | `KnowledgeBase.description` |
| 文档数 | 统计数字 | `KnowledgeBase.documentCount` |
| 分块数 | 统计数字 | `KnowledgeBase.chunkCount` |
| Embedding 模型 | 模型名 | `KnowledgeBase.embeddingModel` |
| 向量维度 | 数字 | `KnowledgeBase.embeddingDimension` |

#### 文档表格

| 列 | 说明 | 来源 |
|------|------|------|
| 文件名 | emoji 图标 + 文件名 + fileType + fileSize | `Document.fileName`, `Document.fileType`, `Document.fileSize` |
| 状态 | Tag 颜色：已上传(灰) / 处理中(蓝+进度条) / 完成(绿) / 失败(红) | `Document.status` |
| 页数 | PDF/DOCX 页数 | `Document.pageCount` |
| 错误信息 | 失败时显示 | `Document.errorMessage` |
| 上传时间 | 格式化时间 | `Document.createdAt` |
| 操作 | 删除按钮 | — |

### 状态轮询

页面挂载时启动 10 秒定时轮询（`setInterval`），当所有文档状态不再是 `UPLOADED`/`PROCESSING` 时自动停止。组件卸载时调用 `stopPolling()` 清理。

### 数据模型

```
Document {
  id              String
  knowledgeBaseId String  (关联 KnowledgeBase)
  fileName        String
  fileType        String     // PDF / DOCX / TXT / MARKDOWN
  fileSize        Int        // 字节
  storagePath     String
  mimeType        String?
  status          String     // UPLOADED / PROCESSING / COMPLETED / FAILED
  errorMessage    String?
  pageCount       Int?
  chunks          DocumentChunk[]
}
```

### 文件处理管线

```
用户上传文件 (UPLOADED)
    ↓ BullMQ Worker
解析 DocumentParserService.parse() → 原始文本
    ↓
Text Cleaning + ChunkService.chunk() → Chunk[]
    ↓
EmbeddingService.embedBatch() → 向量[]
    ↓
VectorStoreService.upsert() → pgvector
    ↓
COMPLETED（或 FAILED 并记录 errorMessage）
```

**API**:
- `GET /api/knowledge-bases/:kbId` — 知识库详情
- `GET /api/knowledge-bases/:kbId/documents` — 文档列表
- `POST /api/knowledge-bases/:kbId/documents/upload` — 上传文档（multipart/form-data）
- `DELETE /api/documents/:id` — 删除文档

---

## 8. 报告页 `/report`

**组件**: `fronted/src/views/report/index.vue`

### 页面用途

AI 报告功能入口。报告是 Agent 的一种输出能力（而非 Workspace 下独立资源），由 Agent 调用工作流/知识库后生成结构化报告。

### 当前状态

🔲 占位页面，仅展示维护中提示。

### 预期布局（参考需求文档 v1.1 第 13 章）

```
┌─────────────────────────────────────────────────────────┐
│ AI 报告                              [+ 创建报告]        │
├─────────────────────────────────────────────────────────┤
│                                                          │
│ ┌────────────────────────────────────────────────────┐ │
│ │ 报告列表（标题、摘要、创建时间、关联 Agent）          │ │
│ ├────────────────────────────────────────────────────┤ │
│ │ 报告编辑器（CKEditor 5 富文本）                     │ │
│ │                                                     │ │
│ │ ▶ 标题、段落、表格、图片、图表、AI 内容              │ │
│ │ ▶ AI 改写                                          │ │
│ │ ▶ 导出 PDF / Word                                   │ │
│ └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

---

## 后端核心数据模型速查

（摘自 `backend/prisma/schema.prisma`）

### 实体关系

```
User ──1:N── Workspace (owner)
User ──1:N── WorkspaceMember
User ──1:N── KnowledgeBase (owner)

Workspace ──1:N── Workflow
Workspace ──1:N── WorkspaceMember
Workspace ──M:N── KnowledgeBase (通过 WorkspaceKnowledgeBase)

Workflow ──1:N── WorkflowVersion
WorkflowVersion ──1:1── Workflow.currentVersion

KnowledgeBase ──1:N── Document
Document ──1:N── DocumentChunk
```

### 状态枚举

| 实体 | 字段 | 可选值 |
|------|------|--------|
| Workflow | `status` | DRAFT / PUBLISHED / ARCHIVED |
| Document | `status` | UPLOADED / PROCESSING / COMPLETED / FAILED |

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端框架 | Vue 3 + TypeScript + `<script setup>` |
| 构建 | Vite |
| 路由 | Vue Router 4 |
| 状态管理 | Pinia (stores/user.ts) |
| UI 组件 | TDesign Vue Next |
| 工作流画布 | VueFlow (@vue-flow/core) |
| CSS | Less + CSS Variables |
| HTTP | Axios (utils/request.ts 统一封装) |
| 后端框架 | NestJS |
| 数据库 | PostgreSQL + Prisma ORM |
| 向量检索 | pgvector |
| 认证 | JWT |
| 异步任务 | BullMQ + Redis |
| 文件处理 | Multer + pdf-parse / mammoth |
