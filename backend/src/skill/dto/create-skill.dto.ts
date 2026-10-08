import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateSkillDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsEnum(['PROMPT', 'WORKFLOW', 'TOOL'])
  type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  instructions?: string;

  @IsOptional()
  inputSchema?: any;

  @IsOptional()
  @IsString()
  outputFormat?: string;

  @IsOptional()
  @IsString()
  workflowId?: string;

  @IsOptional()
  @IsString()
  mcpServerId?: string;

  @IsOptional()
  @IsString()
  mcpToolName?: string;
}
