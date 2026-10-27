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
 * 创建 MCP Server。
 *
 * 两种形态的必填项不同，交叉校验放在 McpService 里做（class-validator 表达条件必填很别扭）：
 *   - 远程（STREAMABLE_HTTP / SSE）：必须给 serverUrl
 *   - 本地（STDIO）：必须给 command，args / env 可选，serverUrl 忽略
 */
export class CreateMcpServerDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  /** Streamable HTTP（推荐）/ 旧版 HTTP + SSE / 本地子进程 stdio */
  @IsOptional()
  @IsEnum(['SSE', 'STREAMABLE_HTTP', 'STDIO'])
  transport?: string;

  /** 远程传输必填；STDIO 不填 */
  @IsOptional()
  @IsString()
  @IsUrl({
    require_tld: false,
    require_protocol: true,
    protocols: ['http', 'https'],
  })
  serverUrl?: string;

  /** STDIO 必填：可执行文件（npx / node / uvx / python …，受服务端白名单限制） */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  command?: string;

  /** STDIO 可选：命令行参数（等价于 Claude Desktop 配置里的 args） */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  args?: string[];

  /** STDIO 可选：额外环境变量（可能含密钥，服务端加密存储） */
  @IsOptional()
  @IsObject()
  env?: Record<string, string>;

  /** 仅远程传输使用 */
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
