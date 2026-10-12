import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/**
 * 更新 Agent 的 DTO。
 *
 * 注意：全局 ValidationPipe 开启了 `whitelist: true`，
 * 因此**每个字段都必须带校验装饰器**，否则会被整体剥离、导致更新变成空操作。
 * 这里所有字段均为可选（Partial 语义）。
 */
export class UpdateAgentDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  avatar?: string;

  @IsIn(['GENERAL', 'KNOWLEDGE', 'WORKFLOW', 'TOOL', 'CUSTOM'])
  @IsOptional()
  type?: 'GENERAL' | 'KNOWLEDGE' | 'WORKFLOW' | 'TOOL' | 'CUSTOM';

  @IsString()
  @IsOptional()
  model?: string;

  /** 自定义模型 id；传空字符串表示清除（回退 Ollama 本地 model） */
  @IsString()
  @IsOptional()
  llmModelId?: string;

  @IsString()
  @IsOptional()
  systemPrompt?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  workflowIds?: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  knowledgeBaseIds?: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  skillIds?: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  mcpServerIds?: string[];

  @IsNumber()
  @Min(1)
  @Max(50)
  @IsOptional()
  maxToolIterations?: number;

  @IsNumber()
  @Min(0)
  @Max(2)
  @IsOptional()
  temperature?: number;

  /** 是否允许 Agent 生成文件；默认 true */
  @IsBoolean()
  @IsOptional()
  enableFileGeneration?: boolean;
}
