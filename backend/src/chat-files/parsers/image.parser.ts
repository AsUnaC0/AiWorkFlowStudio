import { Injectable } from '@nestjs/common';
import type {
  AttachmentImage,
  AttachmentParser,
  ParseInput,
  ParseResult,
} from './parser.types';

/** 单张图片交给视觉模型的体积上限（超过则放弃视觉输入，避免请求被拒） */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * 图片解析器 —— 不做 OCR（暂无 OCR 依赖），而是把原图交给支持视觉输入的模型。
 *
 * - 图片以 base64 形式随消息一起发给模型（见 AiProvider 的 images 支持）
 * - 若当前模型不支持视觉输入，FileContextService 会降级为文字说明，
 *   并提示用户更换支持视觉的模型。
 */
@Injectable()
export class ImageParser implements AttachmentParser {
  readonly supportedExtensions = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];

  async parse(input: ParseInput): Promise<ParseResult> {
    const oversized = input.buffer.length > MAX_IMAGE_BYTES;

    const images: AttachmentImage[] = oversized
      ? []
      : [
          {
            mimeType: normalizeMime(input.mimeType, input.extension),
            base64: input.buffer.toString('base64'),
          },
        ];

    return {
      // 视觉模型读图时不需要文本；给一句占位说明，便于不支持视觉时提示用户
      text: oversized
        ? `[图片文件：${input.fileName}]（图片体积超过 8MB，未随消息发送给模型）`
        : `[图片文件：${input.fileName}]`,
      summary: oversized
        ? `图片 ${input.fileName}（${(input.buffer.length / 1024 / 1024).toFixed(
            1,
          )}MB）超过 8MB，未发送给模型`
        : `图片 ${input.fileName}（${(input.buffer.length / 1024).toFixed(
            1,
          )}KB），已随消息发送给支持视觉的模型`,
      meta: {
        bytes: input.buffer.length,
        oversized,
      },
      images,
    };
  }
}

function normalizeMime(mimeType: string, extension: string): string {
  if (mimeType && mimeType.startsWith('image/')) return mimeType;
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
  };
  return map[extension.toLowerCase()] ?? 'image/png';
}
