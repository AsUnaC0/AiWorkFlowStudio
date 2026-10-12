import { request } from "@/utils/request";
import { useUserStore } from "@/stores/user";
import type {
  GeneratedFile,
  GenerateFileRequest,
  FilePreviewPayload,
  FileFormatOption,
} from "@/types/files";

export type {
  GeneratedFile,
  GenerateFileRequest,
  FilePreviewPayload,
  FileFormatOption,
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
