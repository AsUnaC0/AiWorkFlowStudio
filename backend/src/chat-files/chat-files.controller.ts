import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseArrayPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { JwtUser } from '../auth/strategies/jwt.strategy';
import { ChatFilesService } from './chat-files.service';
import { FileParserService } from './file-parser.service';
import { FilePreviewService } from '../files/file-preview.service';
import { UploadFileDto } from './dto/upload-file.dto';

/**
 * 聊天附件接口（前缀 /api/chat/files）。
 *
 *   GET    /policy                — 上传策略（允许类型 / 大小 / 数量）
 *   GET    /status?ids=           — 批量查询解析状态（前端轮询用）
 *   GET    /                     — 我的附件列表（可按 sessionId 过滤）
 *   POST   /upload                — 上传附件（multipart/form-data，字段 file）
 *   GET    /:id                   — 附件元数据与状态
 *   POST   /:id/reprocess        — 重新解析失败的附件
 *   DELETE /:id                   — 删除附件
 *   GET    /:id/preview           — 预览数据（HTML / 表格 / rawUrl）
 *   GET    /:id/raw               — 原始文件流（inline）
 *   GET    /:id/download          — 原始文件流（attachment 下载）
 *
 * 所有接口要求 JWT，且严格校验 attachment.userId === 当前用户。
 */
@Controller('chat/files')
@UseGuards(JwtAuthGuard)
export class ChatFilesController {
  constructor(
    private readonly chatFiles: ChatFilesService,
    private readonly parser: FileParserService,
    private readonly previewSvc: FilePreviewService,
  ) {}

  /** 上传策略：前端据此做类型 / 大小 / 数量前置校验与提示 */
  @Get('policy')
  getPolicy() {
    return this.parser.getPolicy();
  }

  /** 批量状态：避免前端对 N 个附件各发一次请求 */
  @Get('status')
  async getStatuses(
    @CurrentUser() user: JwtUser,
    @Query('ids', new ParseArrayPipe({ items: String, separator: ',', optional: true }))
    ids?: string[],
  ) {
    return this.chatFiles.getStatuses(user.id, ids ?? []);
  }

  /** 附件列表 */
  @Get()
  async list(
    @CurrentUser() user: JwtUser,
    @Query('sessionId') sessionId?: string,
  ) {
    return this.chatFiles.list(user.id, sessionId);
  }

  /** 上传 */
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 60 * 1024 * 1024 }, // 兜底上限，业务层再做精确校验
      defParamCharset: 'utf8',
    }),
  )
  async upload(
    @CurrentUser() user: JwtUser,
    @UploadedFile() file: {
      originalname: string;
      mimetype: string;
      buffer: Buffer;
      size: number;
    },
    @Body() dto: UploadFileDto,
  ) {
    return this.chatFiles.upload(user.id, file, dto.sessionId);
  }

  /** 附件元数据 */
  @Get(':id')
  async getOne(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.chatFiles.findOne(user.id, id);
  }

  /** 重新解析 */
  @Post(':id/reprocess')
  async reprocess(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.chatFiles.reprocess(user.id, id);
  }

  /** 删除 */
  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    await this.chatFiles.remove(user.id, id);
  }

  /** 预览数据 */
  @Get(':id/preview')
  async preview(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    const attachment = await this.chatFiles.findOne(user.id, id);
    const payload = await this.previewSvc.buildPreview({
      id,
      fileName: attachment.originalName,
      extension: attachment.extension,
      previewType: attachment.previewType,
      storageKey: (await this.chatFiles.getStorageKey(user.id, id)) as string,
    });
    // 修正 rawUrl：附件走自己的接口，而不是 /files/:id/raw
    if (payload.rawUrl) {
      payload.rawUrl = `/api/chat/files/${id}/raw`;
    }
    return payload;
  }

  /** 原始文件流（inline） */
  @Get(':id/raw')
  async raw(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const { attachment, buffer } = await this.chatFiles.readRaw(user.id, id);
    this.writeStream(res, attachment, buffer, 'inline');
  }

  /** 原始文件下载（attachment） */
  @Get(':id/download')
  async download(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const { attachment, buffer } = await this.chatFiles.readRaw(user.id, id);
    this.writeStream(res, attachment, buffer, 'attachment');
  }

  private writeStream(
    res: Response,
    file: { originalName: string; mimeType: string },
    buffer: Buffer,
    disposition: 'inline' | 'attachment',
  ) {
    const encoded = encodeURIComponent(file.originalName);
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename*=UTF-8''${encoded}`,
    );
    res.setHeader('Cache-Control', 'private, max-age=0, no-cache');
    res.end(buffer);
  }
}
