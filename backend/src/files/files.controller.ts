import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { JwtUser } from '../auth/strategies/jwt.strategy';
import { FilesService } from './files.service';
import { FileGeneratorService } from './file-generator.service';
import { CreateFileDto } from './dto/create-file.dto';
import type { GenerateFileInput, GeneratedFileSource } from './types/generated-file.types';

/**
 * 生成文件 API
 *
 *   GET    /api/files/formats          — 支持的格式列表
 *   POST   /api/files/generate         — 生成文件
 *   GET    /api/files                  — 我的文件列表（可按 sessionId 过滤）
 *   GET    /api/files/:id              — 文件元数据
 *   GET    /api/files/:id/preview      — 预览数据（HTML / 表格 / rawUrl）
 *   GET    /api/files/:id/content      — 同上（语义别名）
 *   GET    /api/files/:id/raw          — 原始文件流（inline，前端转 blob 预览）
 *   GET    /api/files/:id/download     — 原始文件流（attachment 下载）
 *   DELETE /api/files/:id              — 删除文件及对象存储对象
 *
 * 安全：所有接口都要求 JWT，且校验 file.userId === 当前用户。
 * 七牛云的 AccessKey / 长期凭证不会下发给前端。
 */
@Controller('files')
@UseGuards(JwtAuthGuard)
export class FilesController {
  constructor(
    private readonly filesService: FilesService,
    private readonly fileGenerator: FileGeneratorService,
  ) {}

  @Get('formats')
  getFormats() {
    return this.fileGenerator.getSupportedFormats();
  }

  @Post('generate')
  async generate(@CurrentUser() user: JwtUser, @Body() dto: CreateFileDto) {
    const input: GenerateFileInput = {
      format: dto.format as GenerateFileInput['format'],
      fileName: dto.fileName,
      title: dto.title,
      summary: dto.summary,
      markdown: dto.markdown,
      blocks: dto.blocks as GenerateFileInput['blocks'],
      sheets: dto.sheets as unknown as GenerateFileInput['sheets'],
      columns: dto.columns,
      rows: dto.rows,
      options: dto.options,
    };

    return this.filesService.generate(input, {
      userId: user.id,
      sessionId: dto.sessionId,
      messageId: dto.messageId,
      sourceType: (dto.sourceType as GeneratedFileSource) ?? 'export',
    });
  }

  @Get()
  async list(
    @CurrentUser() user: JwtUser,
    @Query('sessionId') sessionId?: string,
    @Query('messageId') messageId?: string,
  ) {
    return this.filesService.list(user.id, { sessionId, messageId });
  }

  @Get(':id')
  async getMeta(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.filesService.findOne(user.id, id);
  }

  @Get(':id/preview')
  async preview(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.filesService.getPreview(user.id, id);
  }

  @Get(':id/content')
  async content(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.filesService.getPreview(user.id, id);
  }

  /**
   * 原始文件流（inline）。
   * 前端用 fetch（带 Authorization）取到 blob 后转 blob: URL 给 iframe / img 使用。
   */
  @Get(':id/raw')
  async raw(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const { file, buffer } = await this.filesService.readRaw(user.id, id);
    this.writeStream(res, file, buffer, 'inline');
  }

  /** 原始文件流（attachment）—— 直接下载 */
  @Get(':id/download')
  async download(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const { file, buffer } = await this.filesService.readRaw(user.id, id);
    this.writeStream(res, file, buffer, 'attachment');
  }

  @Delete(':id')
  async remove(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.filesService.remove(user.id, id);
  }

  // ===========================================================================
  // 内部
  // ===========================================================================

  private writeStream(
    res: Response,
    file: { fileName: string; mimeType: string; size: number },
    buffer: Buffer,
    disposition: 'inline' | 'attachment',
  ) {
    // 中文文件名需 RFC 5987 编码，否则下载时乱码
    const encoded = encodeURIComponent(file.fileName);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename*=UTF-8''${encoded}`,
    );
    res.setHeader('Cache-Control', 'private, max-age=0, no-cache');
    res.end(buffer);
  }
}
