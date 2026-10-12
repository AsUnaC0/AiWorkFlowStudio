import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import {
  FORMAT_META,
  GENERATED_FILE_FORMATS,
  type GenerateFileInput,
  type GeneratedBuffer,
  type GeneratedFileFormat,
} from './types/generated-file.types';
import { normalizeDocument } from './generators/markdown.util';
import { generateWord } from './generators/word.generator';
import { generatePdf } from './generators/pdf.generator';
import { generateMarkdown } from './generators/markdown.generator';
import {
  generateCsv,
  generateExcel,
  normalizeSpreadsheet,
} from './generators/excel.generator';

/**
 * FileGeneratorService —— 统一调度各格式生成器。
 *
 * 职责边界：
 *   - 只负责「结构化内容 → 二进制文件」
 *   - 不做存储、不做权限、不写数据库（由 FileStorageService / FilesService 负责）
 *
 * 这样 Chat / Agent / Workflow / Skill 都能复用同一份生成能力。
 */
@Injectable()
export class FileGeneratorService {
  private readonly logger = new Logger(FileGeneratorService.name);

  /** 支持的格式列表（供工具 schema 与前端使用） */
  getSupportedFormats(): Array<{
    format: GeneratedFileFormat;
    label: string;
    extension: string;
  }> {
    return GENERATED_FILE_FORMATS.map((f) => ({
      format: f,
      label: FORMAT_META[f].label,
      extension: FORMAT_META[f].extension,
    }));
  }

  /**
   * 生成文件二进制。
   *
   * @throws BadRequestException 参数不合法或缺少内容
   */
  async generate(
    input: GenerateFileInput,
    meta: { title?: string; author?: string } = {},
  ): Promise<GeneratedBuffer> {
    const format = this.assertFormat(input.format);
    const fileMeta = FORMAT_META[format];
    const fileName = this.buildFileName(input, format);

    switch (format) {
      case 'docx': {
        const content = normalizeDocument(input);
        this.assertHasContent(content.blocks.length > 0 || !!content.title);
        const buffer = await generateWord(content, {
          title: meta.title,
          author: meta.author,
        });
        return { buffer, fileName, ...fileMeta, format };
      }

      case 'pdf': {
        const content = normalizeDocument(input);
        this.assertHasContent(content.blocks.length > 0 || !!content.title);
        const buffer = await generatePdf(content, {
          title: meta.title,
          author: meta.author,
        });
        return { buffer, fileName, ...fileMeta, format };
      }

      case 'md': {
        const content = normalizeDocument(input);
        this.assertHasContent(content.blocks.length > 0 || !!content.title);
        const buffer = await generateMarkdown(content, input.markdown);
        return { buffer, fileName, ...fileMeta, format };
      }

      case 'xlsx': {
        const content = normalizeSpreadsheet(input);
        this.assertHasContent(
          content.sheets.some((s) => (s.rows?.length ?? 0) > 0),
        );
        const buffer = await generateExcel(content, { title: meta.title });
        return { buffer, fileName, ...fileMeta, format };
      }

      case 'csv': {
        const content = normalizeSpreadsheet(input);
        this.assertHasContent(
          content.sheets.some((s) => (s.rows?.length ?? 0) > 0),
        );
        const buffer = await generateCsv(content);
        return { buffer, fileName, ...fileMeta, format };
      }
    }
  }

  // ===========================================================================
  // 校验与工具
  // ===========================================================================

  private assertFormat(format: string): GeneratedFileFormat {
    const normalized = String(format ?? '')
      .toLowerCase()
      .replace(/^\./, '') as GeneratedFileFormat;
    if (!GENERATED_FILE_FORMATS.includes(normalized)) {
      throw new BadRequestException(
        `不支持的文件格式：${format}（支持 ${GENERATED_FILE_FORMATS.join(' / ')}）`,
      );
    }
    return normalized;
  }

  private assertHasContent(ok: boolean) {
    if (!ok) {
      throw new BadRequestException(
        '文件内容为空：请提供 markdown / blocks（文档类）或 sheets / columns+rows（表格类）',
      );
    }
  }

  /** 生成安全文件名：去掉路径分隔符与控制字符，补齐扩展名 */
  private buildFileName(
    input: GenerateFileInput,
    format: GeneratedFileFormat,
  ): string {
    const extension = FORMAT_META[format].extension;
    const raw =
      input.fileName?.trim() ||
      input.title?.trim() ||
      (format === 'xlsx' || format === 'csv' ? '数据表格' : '未命名文档');

    const cleaned = raw
      .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);

    const base = cleaned || '未命名文档';
    return base.toLowerCase().endsWith(`.${extension}`)
      ? base
      : `${base}.${extension}`;
  }
}
