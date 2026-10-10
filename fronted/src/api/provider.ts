import { request } from "@/utils/request";
import type {
  CreateLlmConfigRequest,
  LlmModel,
  LlmProviderConfig,
  ModelCapability,
  TestLlmConfigRequest,
  TestLlmConfigResult,
  UpdateLlmConfigRequest,
  UpdateLlmModelRequest,
} from "@/types/provider";

/** 当前用户全部模型提供商配置（API Key 已脱敏） */
export const getLlmConfigs = (): Promise<LlmProviderConfig[]> =>
  request.get("/llm-configs");

/** 新增模型提供商配置 */
export const createLlmConfig = (
  data: CreateLlmConfigRequest,
): Promise<LlmProviderConfig> => request.post("/llm-configs", data);

/** 更新配置（name / baseUrl / apiKey / 停用） */
export const updateLlmConfig = (
  id: string,
  data: UpdateLlmConfigRequest,
): Promise<LlmProviderConfig> => request.patch(`/llm-configs/${id}`, data);

/** 删除配置（级联删除其下模型） */
export const removeLlmConfig = (id: string): Promise<unknown> =>
  request.delete(`/llm-configs/${id}`);

/** 保存前预测试连接（不落库） */
export const testLlmConfig = (
  data: TestLlmConfigRequest,
): Promise<TestLlmConfigResult> => request.post("/llm-configs/test", data);

/** 对已保存配置测试连接 */
export const testSavedLlmConfig = (
  id: string,
): Promise<TestLlmConfigResult> => request.post(`/llm-configs/${id}/test`);

/** 拉取某配置下的模型列表并落地 */
export const fetchLlmModels = (id: string): Promise<LlmModel[]> =>
  request.get(`/llm-configs/${id}/models`);

/**
 * 当前用户全部可用（启用）模型 —— 供聊天 / 工作流 / 知识库选择器使用。
 * @param capability 可选：按能力过滤，如 "CHAT"（对话）/ "EMBEDDING"（向量）
 */
export const getLlmModels = (capability?: ModelCapability): Promise<LlmModel[]> =>
  request.get("/llm-configs/models", { params: capability ? { capability } : {} });

/** 更新模型（名称 / 能力 / 启用） */
export const updateLlmModel = (
  id: string,
  data: UpdateLlmModelRequest,
): Promise<LlmModel> => request.patch(`/llm-configs/models/${id}`, data);

/** 设为默认模型 */
export const setDefaultLlmModel = (id: string): Promise<LlmModel> =>
  request.patch(`/llm-configs/models/${id}/default`);
