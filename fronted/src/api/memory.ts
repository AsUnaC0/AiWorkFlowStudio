import { request } from "@/utils/request";

// ===========================================================================
// 记忆
//
// 后端约定（很重要）：
//   - 列表 / 图数据只返回摘要与元信息，**不含原文**
//   - 原文只在 getMemory(id) 里返回，详情面板打开时才请求
// ===========================================================================

export interface MemoryListItem {
  id: string;
  category: string;
  categoryLabel: string;
  summary: string;
  importance: number;
  sourceConversationId: string | null;
  lastAccessedAt: string | null;
  accessCount: number;
  createdAt: string;
}

export interface MemoryDetail extends MemoryListItem {
  content: string;
  sourceMessageId: string | null;
  embeddingModel: string | null;
  updatedAt: string;
}

export interface MemoryGraphNode {
  id: string;
  category: string;
  summary: string;
  importance: number;
  degree: number;
  createdAt: string;
}

export interface MemoryGraphLink {
  source: string;
  target: string;
  weight: number;
}

export interface MemoryGraphPayload {
  nodes: MemoryGraphNode[];
  links: MemoryGraphLink[];
  total: number;
  truncated: boolean;
  categories: Array<{ category: string; label: string; count: number }>;
}

export interface MemorySettings {
  autoCaptureEnabled: boolean;
  captureModelId: string | null;
  recallLimit: number;
}

export interface MemoryCategoryMeta {
  category: string;
  label: string;
}

/** 分类 → 中文名（前端本地兜底，接口未返回时也能渲染） */
export const MEMORY_CATEGORY_LABELS: Record<string, string> = {
  PREFERENCE: "偏好",
  FACT: "事实",
  TASK: "任务",
  EVENT: "事件",
  EMOTION: "情感",
  OTHER: "其他",
};

/**
 * 分类配色。
 *
 * 深色底上要用「高饱和 + 中亮度」的发光色，否则 Three.js 的 additive blending
 * 会让颜色全部糊成白色。这套值同时给 3D 节点和列表标签用，保证两处一致。
 */
export const MEMORY_CATEGORY_COLORS: Record<string, string> = {
  PREFERENCE: "#5eead4",
  FACT: "#7dd3fc",
  TASK: "#fbbf24",
  EVENT: "#c4b5fd",
  EMOTION: "#f9a8d4",
  OTHER: "#94a3b8",
};

export const listMemories = (params?: {
  page?: number;
  pageSize?: number;
  category?: string;
}): Promise<{
  items: MemoryListItem[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}> => request.get("/memories", { params });

export const getMemoryGraph = (params?: {
  category?: string;
  limit?: number;
}): Promise<MemoryGraphPayload> => request.get("/memories/graph", { params });

export const getMemory = (id: string): Promise<MemoryDetail> =>
  request.get(`/memories/${id}`);

export const deleteMemory = (id: string): Promise<{ success: boolean }> =>
  request.delete(`/memories/${id}`);

export const clearMemories = (): Promise<{
  success: boolean;
  deleted: number;
}> => request.delete("/memories");

export const getMemorySettings = (): Promise<MemorySettings> =>
  request.get("/memories/settings");

export const updateMemorySettings = (
  data: Partial<MemorySettings>,
): Promise<MemorySettings> => request.put("/memories/settings", data);

export const getMemoryCategories = (): Promise<MemoryCategoryMeta[]> =>
  request.get("/memories/categories");
