import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

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
  @IsEnum(['SSE', 'STREAMABLE_HTTP'])
  transport?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @IsUrl({
    require_tld: false,
    require_protocol: true,
    protocols: ['http', 'https'],
  })
  serverUrl?: string;

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
