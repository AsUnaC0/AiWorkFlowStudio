import { request } from "@/utils/request";
import { useUserStore } from "@/stores/user";
import type {
  CreateEmbeddingVersionRequest,
  CreateKnowledgeBaseRequest,
  EmbeddingVersion,
  KnowledgeBase,
  UpdateKnowledgeBaseRequest,
} from "@/types/knowledge";

// ===========================================================================
// Knowledge Bases（独立资源，owner 权限模型）
// ===========================================================================

/** 创建知识库（当前用户作为 owner） */
export const createKnowledgeBase = (
  data: CreateKnowledgeBaseRequest,
): Promise<KnowledgeBase> => {
  return request.post("/knowledge-bases", data);
};

/** 获取当前用户的全部知识库 */
export const getKnowledgeBases = (): Promise<KnowledgeBase[]> => {
  return request.get("/knowledge-bases");
};

/** 获取单个知识库 */
export const getKnowledgeBase = (id: string): Promise<KnowledgeBase> => {
  return request.get(`/knowledge-bases/${id}`);
};

/** 更新知识库 */
export const updateKnowledgeBase = (
  id: string,
  data: UpdateKnowledgeBaseRequest,
): Promise<KnowledgeBase> => {
  return request.put(`/knowledge-bases/${id}`, data);
};

/** 删除知识库 */
export const removeKnowledgeBase = (id: string): Promise<KnowledgeBase> => {
  return request.delete(`/knowledge-bases/${id}`);
};

// ===========================================================================
// Workspace ↔ KnowledgeBase 关联
// ===========================================================================

/** 获取工作空间关联的知识库 */
export const getKnowledgeBasesByWorkspace = (
  workspaceId: string,
): Promise<KnowledgeBase[]> => {
  return request.get(`/workspaces/${workspaceId}/knowledge-bases`);
};

/** 关联知识库到工作空间 */
export const linkKnowledgeBaseToWorkspace = (
  workspaceId: string,
  kbId: string,
): Promise<void> => {
  return request.post(`/workspaces/${workspaceId}/knowledge-bases/${kbId}`);
};

/** 从工作空间解绑知识库 */
export const unlinkKnowledgeBaseFromWorkspace = (
  workspaceId: string,
  kbId: string,
): Promise<void> => {
  return request.delete(`/workspaces/${workspaceId}/knowledge-bases/${kbId}`);
};

// ===========================================================================
// Documents
// ===========================================================================

export interface DocumentItem {
  id: string;
  knowledgeBaseId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  storagePath: string;
  mimeType: string | null;
  status: "UPLOADED" | "PROCESSING" | "COMPLETED" | "FAILED";
  errorMessage: string | null;
  pageCount: number | null;
  createdAt: string;
  updatedAt: string;
}

/** uploadDocument 返回 —— 后端入队后立即返回（异步处理中） */
export interface UploadDocumentResult {
  documentId: string;
  jobId: string;
  status: "UPLOADED";
  message: string;
}

/** 获取知识库下的全部文档 */
export const getDocuments = (kbId: string): Promise<DocumentItem[]> => {
  return request.get(`/knowledge-bases/${kbId}/documents`);
};

/** 获取单个文档详情（含状态，前端轮询用） */
export const getDocument = (id: string): Promise<DocumentItem> => {
  return request.get(`/documents/${id}`);
};

/** 上传文档（multipart/form-data）—— 返回入队结果，后端异步处理 */
export const uploadDocument = async (
  kbId: string,
  file: File,
): Promise<UploadDocumentResult> => {
  const userStore = useUserStore();
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(`/api/knowledge-bases/${kbId}/documents`, {
    method: "POST",
    headers: userStore.token
      ? { Authorization: `Bearer ${userStore.token}` }
      : {},
    body: formData,
  });

  if (!response.ok) {
    let msg = `上传失败: ${response.status}`;
    try {
      const data = (await response.json()) as { message?: string };
      if (data.message) msg = data.message;
    } catch {
      // 忽略
    }
    throw new Error(msg);
  }

  return response.json();
};

/** 删除文档 */
export const removeDocument = (id: string): Promise<void> => {
  return request.delete(`/documents/${id}`);
};

// ===========================================================================
// 向量版本 / 重新向量化
// ===========================================================================

/** 列出知识库的全部向量版本（含进度） */
export const getEmbeddingVersions = (
  kbId: string,
): Promise<EmbeddingVersion[]> => {
  return request.get(`/knowledge-bases/${kbId}/embedding-versions`);
};

/** 当前生效版本 */
export const getActiveEmbeddingVersion = (
  kbId: string,
): Promise<EmbeddingVersion | null> => {
  return request.get(`/knowledge-bases/${kbId}/embedding-versions/active`);
};

/** 创建目标向量版本（不立即生效） */
export const createEmbeddingVersion = (
  kbId: string,
  data: CreateEmbeddingVersionRequest,
): Promise<EmbeddingVersion> => {
  return request.post(`/knowledge-bases/${kbId}/embedding-versions`, data);
};

/** 启动 / 继续重新向量化任务 */
export const startReEmbed = (
  kbId: string,
  versionId: string,
  retryFailedOnly = false,
): Promise<{ versionId: string; jobId: string; status: string }> => {
  return request.post(
    `/knowledge-bases/${kbId}/embedding-versions/${versionId}/re-embed`,
    { retryFailedOnly },
  );
};

/** 激活指定版本（需已 READY） */
export const activateEmbeddingVersion = (
  kbId: string,
  versionId: string,
): Promise<EmbeddingVersion> => {
  return request.post(
    `/knowledge-bases/${kbId}/embedding-versions/${versionId}/activate`,
  );
};

/** 删除历史版本 */
export const removeEmbeddingVersion = (
  kbId: string,
  versionId: string,
): Promise<{ id: string; deleted: boolean }> => {
  return request.delete(
    `/knowledge-bases/${kbId}/embedding-versions/${versionId}`,
  );
};
