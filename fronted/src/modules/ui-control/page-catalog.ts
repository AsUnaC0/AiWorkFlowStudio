/**
 * 页面目录 & 弹窗映射。
 *
 * 这些是**静态**信息（路由、标题、页面用途），与「页面挂载时动态注册的
 * 执行函数」互补：导航只需要路由；打开弹窗需要知道「弹窗属于哪个页面、
 * 对应的语义化操作名」。
 */

export interface PageCatalogEntry {
  title: string;
  route: string;
  description: string;
}

/** pageId → 页面信息（与后端 ui_navigate 的 page 枚举保持一致） */
export const PAGE_CATALOG: Record<string, PageCatalogEntry> = {
  chat: {
    title: "对话",
    route: "/chat",
    description: "与 AI 助理对话的聊天页",
  },
  dashboard: {
    title: "控制台",
    route: "/dashboard",
    description: "查看资源与模型调用概览",
  },
  skills: {
    title: "Skill 管理",
    route: "/skills",
    description: "管理可复用的 Skill（Prompt / Workflow / Tool）",
  },
  mcp: {
    title: "MCP Server 管理",
    route: "/mcp",
    description: "接入与管理 MCP Server",
  },
  agents: {
    title: "Agent 管理",
    route: "/agents",
    description: "创建与配置 AI Agent",
  },
  knowledge: {
    title: "知识库",
    route: "/knowledge",
    description: "管理知识库与文档",
  },
  workspace: {
    title: "工作空间",
    route: "/workspace",
    description: "管理空间与工作流",
  },
  providers: {
    title: "模型管理",
    route: "/providers",
    description: "配置大模型服务",
  },
  friends: {
    title: "好友",
    route: "/friends",
    description: "好友与协作",
  },
  memory: {
    title: "记忆",
    route: "/memory",
    description: "查看助理的记忆星图",
  },
};

/** 弹窗 id → 归属页面 + 语义化操作名（与后端 ui_open_dialog 的 dialog 枚举一致） */
export const DIALOG_ACTIONS: Record<
  string,
  { action: string; pageId: string; label: string }
> = {
  create_skill: {
    action: "open_create_skill_dialog",
    pageId: "skills",
    label: "新建 Skill",
  },
  create_mcp_server: {
    action: "open_create_mcp_dialog",
    pageId: "mcp",
    label: "新建 MCP Server",
  },
  create_agent: {
    action: "open_create_agent_dialog",
    pageId: "agents",
    label: "创建 Agent",
  },
  create_knowledge_base: {
    action: "open_create_knowledge_dialog",
    pageId: "knowledge",
    label: "创建知识库",
  },
  create_workspace: {
    action: "open_create_workspace_dialog",
    pageId: "workspace",
    label: "创建工作空间",
  },
  create_workflow: {
    action: "open_create_workflow_dialog",
    pageId: "workspace",
    label: "创建工作流",
  },
};

/**
 * 路由 name → pageId。
 * 用于 `router.afterEach` 同步「当前激活页面」。
 */
export const ROUTE_PAGE_MAP: Record<string, string> = {
  Chat: "chat",
  Dashboard: "dashboard",
  SkillList: "skills",
  McpList: "mcp",
  AgentList: "agents",
  AgentDetail: "agents",
  KnowledgeList: "knowledge",
  KnowledgeDetail: "knowledge",
  WorkspaceList: "workspace",
  WorkflowEditor: "workspace",
  ProviderList: "providers",
  FriendList: "friends",
  MemoryGraph: "memory",
};
