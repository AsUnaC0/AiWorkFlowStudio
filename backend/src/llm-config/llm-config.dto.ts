import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { LlmProviderType } from '../ai/providers/provider.factory';

export const PROVIDER_TYPES: LlmProviderType[] = [
  'ollama',
  'openai',
  'deepseek',
  'openai-compatible',
];

/**
 * 模型能力标签（多选，不是互斥的「类型」）：
 *   CHAT             文本生成 / 对话
 *   STREAM           流式输出
 *   TOOLS            工具调用（Function Calling）
 *   EMBEDDING        向量化（知识库检索 / 语义相似度）
 *   VISION           视觉理解（图片问答、OCR 场景理解）
 *   REASONING        推理（复杂分析、多步规划、数学逻辑）
 *   RERANK           重排序（RAG 召回结果二次打分）
 *   IMAGE_GENERATION 图片生成（与「理解图片」完全无关）
 *
 * ⚠️ 能力必须以实测（verifyModel）或用户显式标注为准，不能靠模型名猜测。
 */
export const MODEL_CAPABILITIES = [
  'CHAT',
  'STREAM',
  'TOOLS',
  'EMBEDDING',
  'VISION',
  'REASONING',
  'RERANK',
  'IMAGE_GENERATION',
] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

/** 输入 / 输出模态 */
export const MODALITIES = ['text', 'image', 'audio'] as const;
export type Modality = (typeof MODALITIES)[number];

export class CreateLlmConfigDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @IsEnum(PROVIDER_TYPES)
  provider!: LlmProviderType;

  /** openai-compatible 必填；openai / deepseek 缺省用官方默认地址；ollama 缺省用本地地址 */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  baseUrl?: string;

  /** ollama 可不填；云端厂商必填（服务端加密存储） */
  @IsOptional()
  @IsString()
  apiKey?: string;

  /** 创建时顺带添加的第一个模型（可选） */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  modelId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  displayName?: string;

  @IsOptional()
  @IsArray()
  @IsEnum(MODEL_CAPABILITIES, { each: true })
  capabilities?: ModelCapability[];
}

/** 向已有配置添加指定模型（用户勾选 / 手动填写的 modelId，不再全量拉取） */
export class AddLlmModelsDto {
  @IsArray()
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  modelIds!: string[];

  @IsOptional()
  @IsArray()
  @IsEnum(MODEL_CAPABILITIES, { each: true })
  capabilities?: ModelCapability[];

  /** 仅添加单个模型时的显示名；留空则使用模型 ID */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  displayName?: string;
}

export class UpdateLlmConfigDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  baseUrl?: string;

  /** 仅当传入时才更新密钥；不传则保留原值 */
  @IsOptional()
  @IsString()
  apiKey?: string;

  /** 停用（true）/ 重新启用（false）配置 */
  @IsOptional()
  @IsBoolean()
  disabled?: boolean;

  /** 编辑配置时顺带添加 / 更新一个指定模型（只添加用户填写的这个） */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  modelId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  displayName?: string;

  @IsOptional()
  @IsArray()
  @IsEnum(MODEL_CAPABILITIES, { each: true })
  capabilities?: ModelCapability[];
}

export class UpdateLlmModelDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  displayName?: string;

  @IsOptional()
  @IsArray()
  @IsEnum(MODEL_CAPABILITIES, { each: true })
  capabilities?: ModelCapability[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /** 输入模态：text / image / audio */
  @IsOptional()
  @IsArray()
  @IsEnum(MODALITIES, { each: true })
  inputModalities?: Modality[];

  /** 输出模态：text / image / audio */
  @IsOptional()
  @IsArray()
  @IsEnum(MODALITIES, { each: true })
  outputModalities?: Modality[];

  /** 向量输出维度（仅 EMBEDDING 有意义，建议用「验证模型」实测写入） */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8192)
  embeddingDimensions?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxInputTokens?: number | null;
}

export class TestLlmConfigDto {
  @IsEnum(PROVIDER_TYPES)
  provider!: LlmProviderType;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  baseUrl?: string;

  @IsOptional()
  @IsString()
  apiKey?: string;

  @IsOptional()
  @IsString()
  modelId?: string;
}
