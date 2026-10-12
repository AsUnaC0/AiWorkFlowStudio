import { IsOptional, IsString, IsArray, IsObject, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';
import { GENERATED_FILE_FORMATS } from '../types/generated-file.types';
import type { GeneratedFileFormat } from '../types/generated-file.types';

/** 文档块（Word / PDF / Markdown 通用） */
export class DocBlockDto {
  @IsString()
  type!: string;

  @IsOptional()
  @IsString()
  text?: string;

  @IsOptional()
  level?: number;

  @IsOptional()
  @IsArray()
  items?: string[];

  @IsOptional()
  @IsArray()
  headers?: string[];

  @IsOptional()
  @IsArray()
  rows?: string[][];

  @IsOptional()
  @IsString()
  language?: string;
}

export class SheetColumnDto {
  @IsString()
  header!: string;

  @IsOptional()
  @IsString()
  key?: string;

  @IsOptional()
  width?: number;
}

export class SheetDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsArray()
  @Type(() => SheetColumnDto)
  columns?: SheetColumnDto[];

  @IsOptional()
  @IsArray()
  rows?: unknown[];

  @IsOptional()
  @IsString()
  note?: string;
}

/**
 * 生成文件的请求体。
 *
 * 文档类（docx / pdf / md）：markdown 或 blocks 二选一
 * 表格类（xlsx / csv）：sheets 或 columns + rows
 */
export class CreateFileDto {
  /** 目标格式：docx / xlsx / pdf / md / csv */
  @IsString()
  format!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  fileName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  summary?: string;

  /** Markdown 原文（文档类推荐） */
  @IsOptional()
  @IsString()
  markdown?: string;

  /** 结构化文档块 */
  @IsOptional()
  @IsArray()
  @Type(() => DocBlockDto)
  blocks?: DocBlockDto[];

  /** 多工作表（表格类推荐） */
  @IsOptional()
  @IsArray()
  @Type(() => SheetDto)
  sheets?: SheetDto[];

  /** 单表快捷：列名 */
  @IsOptional()
  @IsArray()
  columns?: string[];

  /** 单表快捷：行数据（二维数组） */
  @IsOptional()
  @IsArray()
  rows?: unknown[][];

  /** 归属会话 / 消息（可选，用于把文件卡片挂到聊天消息上） */
  @IsOptional()
  @IsString()
  sessionId?: string;

  @IsOptional()
  @IsString()
  messageId?: string;

  @IsOptional()
  @IsString()
  sourceType?: string;

  @IsOptional()
  @IsObject()
  options?: Record<string, unknown>;
}

export function isSupportedFormat(format: string): format is GeneratedFileFormat {
  return GENERATED_FILE_FORMATS.includes(format as GeneratedFileFormat);
}
