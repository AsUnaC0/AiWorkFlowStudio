> **分册说明**：本文是《AI WorkFlow Studio 项目需求与技术方案 v1.5（MCP / Skill 更新版）》的拆分分册之一，覆盖原文档**第 4 章**（Workspace / Workflow / Node 三个核心概念与示例）。内容与原文一致，仅按模块拆开便于单独阅读。
> **分册索引**：[README](./README.md) ｜ 上一册：[01-项目概述与技术栈.md](./01-项目概述与技术栈.md) ｜ 下一册：[03-工作流节点体系.md](./03-工作流节点体系.md)

---

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

> v1.4 双模式说明：   两种模式的核心差异在于   配置的精细程度  ：
>
> - 简单模式  ：在 LLM 节点勾选知识库 → 使用默认 Embedding 模型 + 默认检索参数，快速搭建
> - 高级模式  ：独立 RAG 节点 → 可独立选择 Embedding 模型、检索模式、Top K、相似度阈值、LLM 模型、Prompt 等全链路参数
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
