export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpServer {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  transport: "SSE" | "STREAMABLE_HTTP";
  serverUrl: string;
  authType: "NONE" | "API_KEY" | "BEARER_TOKEN";
  status: "DISCONNECTED" | "CONNECTED" | "ERROR";
  lastError: string | null;
  availableTools: McpTool[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMcpServerRequest {
  name: string;
  description?: string;
  transport?: "SSE" | "STREAMABLE_HTTP";
  serverUrl: string;
  authType?: "NONE" | "API_KEY" | "BEARER_TOKEN";
  apiKey?: string;
  bearerToken?: string;
}

export interface UpdateMcpServerRequest {
  name?: string;
  description?: string;
  transport?: "SSE" | "STREAMABLE_HTTP";
  serverUrl?: string;
  authType?: "NONE" | "API_KEY" | "BEARER_TOKEN";
  apiKey?: string;
  bearerToken?: string;
}

export interface TestConnectionResult {
  success: boolean;
  status: "CONNECTED" | "ERROR";
  tools: McpTool[];
  message: string;
}
