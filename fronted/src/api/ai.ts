import { request } from "@/utils/request";

export interface AiModel {
  name: string;
  size?: number;
  modifiedAt?: string | null;
}

export interface ListModelsResponse {
  provider: string;
  models: AiModel[];
  note?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  knowledgeBaseIds?: string[];
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatResponse {
  content: string;
  model: string;
  usage?: ChatUsage;
}

export const getModels = (): Promise<ListModelsResponse> => {
  return request.get("/ai/models");
};

export const chat = (data: ChatRequest): Promise<ChatResponse> => {
  return request.post("/ai/chat", data);
};
