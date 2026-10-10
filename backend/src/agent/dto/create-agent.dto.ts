import {
  IsOptional,
  IsString,
  IsIn,
  IsArray,
  IsNumber,
  Max,
  Min,
} from 'class-validator';

export class CreateAgentDto {
  @IsString()
  name!: string;

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

  /** 关联用户在「模型管理」中添加的自定义模型 id（优先于 model）；不传则回退 Ollama 本地 model */
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
}
