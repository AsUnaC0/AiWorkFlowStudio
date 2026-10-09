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
