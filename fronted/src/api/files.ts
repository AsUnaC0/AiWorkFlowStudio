import { request } from "@/utils/request";
import { useUserStore } from "@/stores/user";
import type {
  GeneratedFile,
  GenerateFileRequest,
  FilePreviewPayload,
  FileFormatOption,
  ChatAttachment,
  ChatFilePolicy,
} from "@/types/files";

export type {
  GeneratedFile,
  GenerateFileRequest,
  FilePreviewPayload,
  FileFormatOption,
  ChatAttachment,
  ChatFilePolicy,
};

// ===========================================================================
// 生成文件 API
// ===========================================================================

/** 支持的生成格式列表 */
export const getFileFormats = (): Promise<FileFormatOption[]> => {
  return request.get(`/files/formats`);
};

/** 生成文件（后端真实生成 + 落库，成功后返回 READY 状态） */
export const generateFile = (
  data: GenerateFileRequest,
): Promise<GeneratedFile> => {
  return request.post(`/files/generate`, data);
};

/** 我的文件列表 */
export const listFiles = (params?: {
  sessionId?: string;
  messageId?: string;
}): Promise<GeneratedFile[]> => {
  return request.get(`/files`, { params });
};

/** 文件元数据 */
export const getFile = (fileId: string): Promise<GeneratedFile> => {
  return request.get(`/files/${fileId}`);
};

/** 预览数据（HTML / 表格 / rawUrl） */
export const getFilePreview = (fileId: string): Promise<FilePreviewPayload> => {
  return request.get(`/files/${fileId}/preview`);
};

/** 删除文件 */
export const deleteFile = (
  fileId: string,
): Promise<{ id: string; deleted: boolean }> => {
  return request.delete(`/files/${fileId}`);
};

/** 原始文件地址（供下载使用） */
export const getFileDownloadUrl = (fileId: string): string =>
  `/api/files/${fileId}/download`;

/**
 * 带鉴权抓取原始文件，返回 blob URL。
 *
 * 七牛云为私有空间，不能直接把对象 Key 拼成 URL 交给浏览器；
 * 这里用 Authorization 头换取 blob，再交给 iframe / img 渲染。
 */
export const fetchFileBlob = async (fileId: string): Promise<string> => {
  const userStore = useUserStore();
  const response = await fetch(`/api/files/${fileId}/raw`, {
    headers: {
      ...(userStore.token ? { Authorization: `Bearer ${userStore.token}` } : {}),
    },
  });

  if (!response.ok) {
    throw new Error(`文件读取失败: ${response.status}`);
  }

  const blob = await response.blob();
  return URL.createObjectURL(blob);
};

/** 触发浏览器下载（走后端鉴权接口） */
export const downloadFile = async (file: GeneratedFile): Promise<void> => {
  const userStore = useUserStore();
  const response = await fetch(`/api/files/${file.id}/download`, {
    headers: {
      ...(userStore.token ? { Authorization: `Bearer ${userStore.token}` } : {}),
    },
  });

  if (!response.ok) {
    throw new Error(`文件下载失败: ${response.status}`);
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

// ===========================================================================
// 聊天附件 API（与知识库 Document 解耦，普通消息附件不上传知识库 / 不向量化）
// ===========================================================================

/** 上传策略：前端据此做类型 / 大小 / 数量前置校验 */
export const getChatFilePolicy = (): Promise<ChatFilePolicy> =>
  request.get(`/chat/files/policy`);

/**
 * 上传聊天附件（multipart/form-data，字段 file）。
 * 不手动设置 Content-Type，让 axios 自动带上 multipart boundary。
 */
export const uploadChatFile = (file: File, sessionId?: string): Promise<ChatAttachment> => {
  const form = new FormData();
  form.append("file", file);
  if (sessionId) form.append("sessionId", sessionId);
  return request.post(`/chat/files/upload`, form);
};

/** 批量查询解析状态（前端轮询用） */
export const getChatFileStatuses = (ids: string[]): Promise<ChatAttachment[]> =>
  request.get(`/chat/files/status`, { params: { ids: ids.join(",") } });

/** 删除附件 */
export const deleteChatFile = (
  id: string,
): Promise<{ id: string; deleted: boolean }> =>
  request.delete(`/chat/files/${id}`);

/** 重新解析失败的附件 */
export const reprocessChatFile = (id: string): Promise<ChatAttachment> =>
  request.post(`/chat/files/${id}/reprocess`);

/** 预览数据（HTML / 表格 / rawUrl），结构与文件预览一致 */
export const getChatFilePreview = (id: string): Promise<FilePreviewPayload> =>
  request.get(`/chat/files/${id}/preview`);

/** 带鉴权抓取原始文件，返回 blob URL（私有对象存储不暴露永久地址） */
export const fetchChatFileBlob = async (id: string): Promise<string> => {
  const userStore = useUserStore();
  const response = await fetch(`/api/chat/files/${id}/raw`, {
    headers: {
      ...(userStore.token ? { Authorization: `Bearer ${userStore.token}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`文件读取失败: ${response.status}`);
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
};

/** 触发浏览器下载聊天附件（走后端鉴权接口） */
export const downloadChatFile = async (att: ChatAttachment): Promise<void> => {
  const userStore = useUserStore();
  const response = await fetch(`/api/chat/files/${att.id}/download`, {
    headers: {
      ...(userStore.token ? { Authorization: `Bearer ${userStore.token}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`文件下载失败: ${response.status}`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = att.originalName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};
