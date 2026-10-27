import { request } from "@/utils/request";
import type {
  CallMcpToolRequest,
  CallMcpToolResult,
  CreateMcpServerRequest,
  McpCapabilities,
  McpServer,
  McpTool,
  TestConnectionResult,
  UpdateMcpServerRequest,
} from "@/types/mcp";

// ===========================================================================
// MCP Servers —— 独立资源，owner 权限模型
// ===========================================================================

/**
 * 传输能力（stdio 是否启用 + 允许的命令白名单）。
 * 注意这个路由必须排在 `/mcp-servers/:id` 之前（后端已保证声明顺序）。
 */
export const getMcpCapabilities = (): Promise<McpCapabilities> => {
  return request.get("/mcp-servers/capabilities");
};

/** 创建 MCP Server */
export const createMcpServer = (data: CreateMcpServerRequest): Promise<McpServer> => {
  return request.post("/mcp-servers", data);
};

/** 获取当前用户的全部 MCP Servers */
export const getMcpServers = (): Promise<McpServer[]> => {
  return request.get("/mcp-servers");
};

/** 获取单个 MCP Server */
export const getMcpServer = (serverId: string): Promise<McpServer> => {
  return request.get(`/mcp-servers/${serverId}`);
};

/** 更新 MCP Server */
export const updateMcpServer = (
  serverId: string,
  data: UpdateMcpServerRequest,
): Promise<McpServer> => {
  return request.put(`/mcp-servers/${serverId}`, data);
};

/** 删除 MCP Server */
export const removeMcpServer = (serverId: string): Promise<McpServer> => {
  return request.delete(`/mcp-servers/${serverId}`);
};

/** 测试 MCP Server 连接（initialize 握手 + tools/list，结果落库） */
export const testMcpConnection = (serverId: string): Promise<TestConnectionResult> => {
  return request.post(`/mcp-servers/${serverId}/test`);
};

/** 刷新工具列表（重新握手并覆盖缓存） */
export const refreshMcpTools = (serverId: string): Promise<TestConnectionResult> => {
  return request.post(`/mcp-servers/${serverId}/tools/refresh`);
};

/** 实时发现工具列表（不落库） */
export const getMcpTools = (serverId: string): Promise<McpTool[]> => {
  return request.get(`/mcp-servers/${serverId}/tools`);
};

/** 调试用：直接调用某个 MCP 工具 */
export const callMcpTool = (
  serverId: string,
  data: CallMcpToolRequest,
): Promise<CallMcpToolResult> => {
  return request.post(`/mcp-servers/${serverId}/tools/call`, data);
};
