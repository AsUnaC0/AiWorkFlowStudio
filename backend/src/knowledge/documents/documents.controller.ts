import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { JwtUser } from '../../auth/strategies/jwt.strategy';
import { DocumentService } from './document.service';
import { DocumentParserService } from './document-parser.service';
import { ChunkService } from './chunk/chunk.service';

const ALLOWED_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md', '.markdown'];
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const UPLOAD_DIR = join(process.cwd(), 'uploads');

const EXT_TO_TYPE: Record<string, string> = {
  '.pdf': 'PDF',
  '.docx': 'DOCX',
  '.txt': 'TXT',
  '.md': 'MARKDOWN',
  '.markdown': 'MARKDOWN',
};

@Controller()
@UseGuards(JwtAuthGuard)
export class DocumentsController {
  constructor(
    private readonly documentService: DocumentService,
    private readonly documentParserService: DocumentParserService,
    private readonly chunkService: ChunkService,
  ) {}

  // ===========================================================================
  // 上传
  // ===========================================================================

  /** 上传文档到指定知识库（kb 必须归当前用户所有） */
  @Post('knowledge-bases/:kbId/documents')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_FILE_SIZE } }),
  )
  async upload(
    @CurrentUser() user: JwtUser,
    @Param('kbId', ParseUUIDPipe) kbId: string,
    @UploadedFile()
    file: {
      fieldname: string;
      originalname: string;
      encoding: string;
      mimetype: string;
      buffer: Buffer;
      size: number;
    },
  ) {
    // owner 校验
    await this.documentService.assertKbOwner(user.id, kbId);

    if (!file) {
      throw new HttpException('文件不能为空', HttpStatus.BAD_REQUEST);
    }

    const ext = extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new HttpException(
        `不支持的文件类型：${ext}，允许：${ALLOWED_EXTENSIONS.join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    // 落盘
    const documentId = crypto.randomUUID();
    const storageDir = join(UPLOAD_DIR, kbId);
    const storagePath = join(storageDir, `${documentId}${ext}`);

    await mkdir(storageDir, { recursive: true });
    await writeFile(storagePath, file.buffer);

    // 先创建文档记录，状态为 PROCESSING
    const doc = await this.documentService.create({
      knowledgeBaseId: kbId,
      fileName: file.originalname,
      fileType: EXT_TO_TYPE[ext] ?? ext.replace('.', '').toUpperCase(),
      fileSize: file.size,
      storagePath,
      mimeType: file.mimetype,
      status: 'PROCESSING',
    });

    // 解析、分块、存储
    try {
      const text = await this.documentParserService.parse(storagePath);
      const chunks = await this.chunkService.split(text);
      await this.chunkService.createMany(doc.id, kbId, chunks);

      // 成功 → COMPLETED
      await this.documentService.updateStatus(doc.id, 'COMPLETED');
    } catch (err) {
      const message = err instanceof Error ? err.message : '未知解析错误';

      // 失败 → FAILED
      await this.documentService.updateStatus(doc.id, 'FAILED', message);

      throw new HttpException(
        `文档处理失败：${message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    // 重新获取，返回最终状态的文档记录
    return this.documentService.findOne(doc.id);
  }

  // ===========================================================================
  // 列表 / 详情
  // ===========================================================================

  @Get('knowledge-bases/:kbId/documents')
  async list(
    @CurrentUser() user: JwtUser,
    @Param('kbId', ParseUUIDPipe) kbId: string,
  ) {
    await this.documentService.assertKbOwner(user.id, kbId);
    return this.documentService.findByKnowledgeBase(kbId);
  }

  @Get('documents/:id')
  async findOne(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.documentService.assertDocumentOwner(user.id, id);
    return this.documentService.findOne(id);
  }

  // ===========================================================================
  // 删除
  // ===========================================================================

  @Delete('documents/:id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.documentService.assertDocumentOwner(user.id, id);
    await this.documentService.remove(id);
  }
}
