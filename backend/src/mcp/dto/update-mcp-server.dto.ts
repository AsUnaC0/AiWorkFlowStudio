import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

/**
 * 更新 MCP Server（全部字段可选，只更新传入的）。
 * 交叉校验（STDIO 要 command、远程要 serverUrl）由 McpService 结合库里已有值判断。
 */
export class UpdateMcpServerDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsEnum(['SSE', 'STREAMABLE_HTTP', 'STDIO'])
  transport?: string;

  @IsOptional()
  @IsString()
  @IsUrl({
    require_tld: false,
    require_protocol: true,
    protocols: ['http', 'https'],
  })
  serverUrl?: string;

  /** STDIO：可执行文件 */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  command?: string;

  /** STDIO：命令行参数 */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  args?: string[];

  /** STDIO：环境变量（整体覆盖，加密存储） */
  @IsOptional()
  @IsObject()
  env?: Record<string, string>;

  @IsOptional()
  @IsEnum(['NONE', 'API_KEY', 'BEARER_TOKEN'])
  authType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  apiKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  bearerToken?: string;
}
