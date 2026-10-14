import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** 调试用：直接调用某个 MCP Server 上的工具 */
export class CallToolDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  toolName!: string;

  /** 工具入参（MCP 的 arguments 对象） */
  @IsOptional()
  @IsObject()
  arguments?: Record<string, unknown>;
}
