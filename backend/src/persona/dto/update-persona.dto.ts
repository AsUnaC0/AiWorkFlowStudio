import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  PERSONA_LIMITS,
  PROACTIVE_FREQUENCIES,
} from '../persona.prompt';

/**
 * 更新人格配置的 DTO。
 *
 * 全局 ValidationPipe 开了 `whitelist: true` —— 没加装饰器的字段会被整体剥离，
 * 所以每个字段都必须显式声明校验规则，否则「保存了但没生效」且不报错。
 *
 * 刻意**不提供** agentId / personaVersion：
 *   - agentId 来自 URL，服务端会校验它确实是系统默认助理
 *   - personaVersion 由服务端自增，客户端无权指定
 */
export class UpdatePersonaDto {
  @IsString()
  @MaxLength(PERSONA_LIMITS.nameMax)
  @IsOptional()
  name?: string;

  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(PERSONA_LIMITS.tagsMax)
  @IsOptional()
  tags?: string[];

  @IsString()
  @MaxLength(PERSONA_LIMITS.promptMax)
  @IsOptional()
  systemPrompt?: string;

  @IsString()
  @IsOptional()
  avatar?: string;

  @IsBoolean()
  @IsOptional()
  voiceEnabled?: boolean;

  // 不再限定 Edge 白名单：允许 BreezeBlue 的自定义 voiceId（形如 voc_xxx）
  @IsString()
  @MaxLength(120)
  @IsOptional()
  voiceId?: string;

  @IsNumber()
  @Min(0.5)
  @Max(2)
  @IsOptional()
  speechRate?: number;

  @IsNumber()
  @Min(0.5)
  @Max(2)
  @IsOptional()
  pitch?: number;

  @IsBoolean()
  @IsOptional()
  desktopPetEnabled?: boolean;

  @IsBoolean()
  @IsOptional()
  proactiveChatEnabled?: boolean;

  @IsIn(PROACTIVE_FREQUENCIES)
  @IsOptional()
  proactiveChatFrequency?: string;

  @IsBoolean()
  @IsOptional()
  screenPerceptionEnabled?: boolean;

  @IsNumber()
  @Min(30)
  @Max(3600)
  @IsOptional()
  screenPerceptionInterval?: number;
}
