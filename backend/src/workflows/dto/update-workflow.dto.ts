import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class UpdateWorkflowDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  /**
   * 画布内容。设为可选是为了支持「只改名字/描述、不动画布」的场景（如列表页重命名）：
   * 不传 definition 时不会产生新的 WorkflowVersion，也不会把已发布工作流标成「有未发布改动」。
   */
  @IsOptional()
  @IsObject()
  definition?: Record<string, unknown>;
}
