import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * 记忆生成 / 召回偏好。
 *
 * 全局 ValidationPipe 开了 `whitelist: true`，没加装饰器的字段会被剥离，
 * 所以这里必须逐个声明 —— 否则「改了没生效」且不报错。
 */
export class UpdateMemorySettingsDto {
  /** 是否允许对话后自动沉淀记忆 */
  @IsBoolean()
  @IsOptional()
  autoCaptureEnabled?: boolean;

  /** 抽取记忆使用的模型 id；传空字符串表示清除（回退用户默认对话模型） */
  @IsString()
  @IsOptional()
  captureModelId?: string | null;

  /** 召回注入对话的条数上限（1~10） */
  @IsInt()
  @Min(1)
  @Max(10)
  @IsOptional()
  recallLimit?: number;
}
