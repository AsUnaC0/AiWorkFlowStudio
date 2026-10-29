> **分册说明**：本文是《AI WorkFlow Studio 项目需求与技术方案 v1.5（MCP / Skill 更新版）》的拆分分册之一，覆盖原文档**第 12~13 章**（Agent 能力边界、Skill 与 MCP 职责、报告/表格/图表输出契约）。内容与原文一致，仅按模块拆开便于单独阅读。
> **分册索引**：[README](./README.md) ｜ 上一册：[06-知识库与RAG.md](./06-知识库与RAG.md) ｜ 下一册：[08-用户系统与权限.md](./08-用户系统与权限.md)

---

# 12. AI Agent

Agent 是平台的上层智能应用能力，不是第一阶段 Workflow 的核心依赖。

Agent 的核心职责：

> 根据用户需求进行理解、决策，并选择和调用已经配置好的工具能力，最终生成面向用户的结果。

### Agent 可以调用的能力

```text
Published Workflow Tool
Knowledge Base Tool
Built-in Tools
MCP Tools（外部工具 / 数据源）
Skills（可复用任务能力）
```

- `Workflow Tool`：仅调用 Workspace 中已发布且已授权的 Workflow。
- `Knowledge Tool`：调用 Agent 被授权使用的 Knowledge Base。
- `MCP Tools`：通过已配置的 MCP Server 发现并调用工具，例如外部 API、文件系统、数据库或业务系统；实际能力取决于用户配置的 MCP Server。
- `Skills`：把某类任务的说明、步骤、输入输出约定、限制和推荐工具封装为可复用能力。Skill 本身不等于外部工具连接；需要访问外部系统时仍应调用已授权的 MCP Tool 或平台工具。

Agent 可以根据用户任务选择 Skill，并在 Skill 的指导下调用 Workflow、Knowledge Base 或 MCP Tool。任何工具都必须先经过当前 Agent 的授权范围校验，不允许模型绕过权限直接访问未授权资源。

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

# 13. Agent 输出与动态内容生成（报告 / 表格 / 图表）

本章将原“报告功能”调整为 Agent 的通用输出能力，不建设独立的 Report 核心资源、独立报告工作台或必须经过的 Report Editor 页面。用户在聊天页面使用 Agent 时，可直接获得普通回答、结构化数据、长文档、报告、表格或图表；这些内容是一次 Agent Run 的输出产物。

## 13.1 输出类型

```text
Agent Response
├── text / Markdown：普通回答与长文档
├── structured data：JSON 等结构化结果
├── table：表格数据
├── chart：图表配置 + 数据序列
└── report：由标题、摘要、章节、表格、图表、引用等组成的复合内容
```

报告不是独立产品功能，而是 `artifactType = report` 的一种输出类型。它不需要专用 Workflow Report Node；Workflow 可返回原始数据或结构化结果，Agent 再按用户意图组合成最终内容。

## 13.2 Skill 与 MCP 在输出生成中的职责

- **Skill** 负责复用任务方法，例如“生成销售分析报告”“分析 CSV 并生成图表”“生成周报”。Skill 中可声明用途、适用场景、输入要求、执行步骤、输出格式、图表建议、事实核验要求和可使用的工具。
- **MCP** 负责连接外部工具与数据源。例如从授权的业务系统取数、读取文件、查询数据库，或调用已配置的图表 / 文件处理工具。MCP 是否具备某项能力取决于已连接的 Server 与工具，平台不能假定所有 MCP 都能绘图或导出文件。
- **Agent / LLM** 负责理解请求、选择 Skill、规划调用顺序、执行授权工具、检查结果并组织最终输出。
- **结果渲染层** 负责把 Agent 返回的结构化内容渲染为 Markdown、表格、图表和报告布局。图表应优先使用前端 ECharts 等现有可视化能力，MCP 不是图表显示的必需条件。

示例：用户说“分析本月销售数据，生成报告并展示趋势图”时，Agent 可选择“数据分析报告”Skill，调用已授权 MCP 工具或已发布 Workflow 获取销售数据，整理为结构化数据，输出报告章节与图表配置，最后由聊天结果区直接渲染。若数据源工具未授权或调用失败，Agent 应说明缺失数据，不得编造图表数值。

## 13.3 推荐输出契约

建议 Agent 使用可校验的结构化输出契约，避免只返回一段无法稳定渲染的自由文本：

```ts
type AgentArtifactType = 'text' | 'markdown' | 'json' | 'table' | 'chart' | 'report';

interface AgentArtifact {
  type: AgentArtifactType;
  title?: string;
  content?: string;
  data?: Record<string, unknown> | unknown[];
  sections?: Array<{
    id: string;
    title: string;
    content?: string;
    blocks?: AgentArtifact[];
  }>;
  citations?: Array<{
    label: string;
    source?: string;
    url?: string;
  }>;
}
```

图表数据应与图表配置分开保存，并校验图表类型、字段映射和数据格式。渲染器只接受平台定义的安全图表 Schema，不直接执行模型生成的任意 HTML、JavaScript 或 Vue 代码。

## 13.4 聊天结果区交互

- 文本 / Markdown：在消息气泡中渲染。
- 表格：以可滚动表格显示；数据量大时可分页或折叠。
- 图表：以 ECharts 渲染，并提供图表标题、图例、数据查看等基础交互。
- 报告：在同一条 Agent 回复中渲染标题、摘要、章节、表格、图表和来源，不跳转到独立报告功能页面。
- 导出：可选提供“导出 Markdown / PDF / Word”动作，导出是对当前输出产物的操作，不要求建立独立 Report 资源。导出失败时展示错误并允许重试。
- 编辑：允许用户在聊天结果中继续要求 Agent 修改内容；后续如实现人工富文本编辑，应作为输出结果的内联编辑能力或通用编辑器，而不是新增报告核心模块。

## 13.5 生成原则

1. 优先使用 JSON Schema / Structured Output，校验后再渲染。
2. 数据分析报告中的数字、指标和图表必须来自工具返回的数据或用户提供的数据；明确区分事实、推断和建议。
3. Skill 可建议输出章节和图表类型，但不能替代数据获取工具。
4. MCP Tool 的执行结果需记录来源与时间；敏感结果不得无授权写入会话或日志。
5. 输出中引用外部来源时尽量保留来源名称 / URL，便于用户核验。
6. PDF / Word 导出为可选增强项，不阻塞文本、表格和图表在聊天页的直接展示。

## 13.6 Agent 输出执行链路

```text
用户在聊天页面提出需求
  ↓
Agent 识别任务与预期输出
  ↓
选择已启用 Skill（可选）
  ↓
按授权调用 Workflow / Knowledge Base / MCP Tools（可选）
  ↓
整合并校验数据
  ↓
生成 AgentArtifact（report / chart / table / text ...）
  ↓
聊天结果区安全渲染
  ↓
用户继续追问 / 修改 / 可选导出
```

***
