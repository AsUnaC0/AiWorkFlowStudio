import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import type { LlmProviderType } from '../ai/providers/provider.factory';

export const PROVIDER_TYPES: LlmProviderType[] = [
  'ollama',
  'openai',
  'deepseek',
  'openai-compatible',
];

/** 模型能力枚举 */
export const MODEL_CAPABILITIES = [
  'CHAT',
  'STREAM',
  'TOOLS',
  'EMBEDDING',
] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

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
