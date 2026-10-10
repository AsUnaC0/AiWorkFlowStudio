import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateKnowledgeBaseDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  embeddingModel?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8192)
  embeddingDimension?: number;

  /** 自定义 Embedding 模型 id；传空字符串表示清除（回退本地 embeddingModel） */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  embeddingLlmModelId?: string;
}
