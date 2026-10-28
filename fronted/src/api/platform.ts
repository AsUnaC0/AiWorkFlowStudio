import { request } from "@/utils/request";
import type { AgentOperation } from "@/types/agent";

// ===========================================================================
// 平台助理
// ===========================================================================

export interface PlatformPersonaSummary {
  name: string;
  tags: string[];
  avatar: string | null;
  voiceEnabled: boolean;
  voiceId: string;
  proactiveChatEnabled: boolean;
  proactiveChatFrequency: string;
  desktopPetEnabled: boolean;
  screenPerceptionEnabled: boolean;
  screenPerceptionInterval: number;
  personaVersion: number;
}

export interface PlatformAssistantInfo {
  id: string;
  /** 系统标识名，固定为「平台助理」 */
  name: string;
  /** 界面展示名 = 人格名（默认「小蝶」）；改人格名时这里跟着变 */
  displayName: string;
  persona: PlatformPersonaSummary;
  description: string | null;
  isPlatformAssistant: boolean;
  /** 后端解析后的当前工作空间（可能为空） */
  currentWorkspaceId: string | null;
  currentWorkspaceName: string | null;
  workspaces: Array<{ id: string; name: string; role: "OWNER" | "MEMBER" }>;
  capabilities: Array<{
    name: string;
    label: string;
    action: AgentOperation["action"];
    riskLevel: AgentOperation["riskLevel"];
  }>;
}

/** 平台助理基本信息 + 能力清单 + 可访问工作空间 */
export const getPlatformAssistant = (): Promise<PlatformAssistantInfo> =>
  request.get("/platform/assistant");

// ===========================================================================
// 操作记录（审计）
// ===========================================================================

export interface PlatformOperationRecord extends AgentOperation {
  id: string;
  workspaceId: string | null;
  sessionId: string | null;
  agentId: string | null;
  createdAt: string;
  errorMessage: string | null;
}

/** 查询当前用户的操作记录 */
export const listPlatformOperations = (params?: {
  sessionId?: string;
  targetType?: string;
  targetId?: string;
  status?: string;
  tool?: string;
  limit?: number;
}): Promise<PlatformOperationRecord[]> =>
  request.get("/platform/operations", { params });

/** 操作统计（按状态分组） */
export const getPlatformOperationStats = (): Promise<
  Array<{ status: string; count: number }>
> => request.get("/platform/operations/stats");
