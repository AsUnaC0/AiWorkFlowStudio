import { request } from "@/utils/request";
import type {
  CreateMcpServerRequest,
  McpServer,
  TestConnectionResult,
  UpdateMcpServerRequest,
} from "@/types/mcp";

// ===========================================================================
// MCP Servers —— 独立资源，owner 权限模型
// ===========================================================================

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

/** 测试 MCP Server 连接 */
export const testMcpConnection = (serverId: string): Promise<TestConnectionResult> => {
  return request.post(`/mcp-servers/${serverId}/test`);
};
