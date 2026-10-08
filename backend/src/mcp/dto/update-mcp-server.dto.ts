import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
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
  serverUrl?: string;

  @IsOptional()
  @IsEnum(['NONE', 'API_KEY', 'BEARER_TOKEN'])
  authType?: string;

  @IsOptional()
  @IsString()
  apiKey?: string;

  @IsOptional()
  @IsString()
  bearerToken?: string;
}
