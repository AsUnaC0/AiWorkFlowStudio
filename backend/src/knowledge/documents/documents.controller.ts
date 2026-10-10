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
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { extname } from 'node:path';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { JwtUser } from '../../auth/strategies/jwt.strategy';
import { DocumentService } from './document.service';
import { StorageService } from '../../storage/storage.service';

const ALLOWED_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md', '.markdown'];
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

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
    private readonly storageService: StorageService,
    @InjectQueue('document-processing')
    private readonly documentQueue: Queue,
  ) {}

  // ===========================================================================
  // 上传（异步：只保存文件 + 创建记录 + 入队）
  // ===========================================================================

  /** 上传文档 → 立即返回，后台 BullMQ 队列处理 */
  @Post('knowledge-bases/:kbId/documents')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_FILE_SIZE },
      defParamCharset: 'utf8',
    }),
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
    // 1) owner 校验
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

    // 2) 通过 StorageService 上传（本地磁盘 / 七牛云 自动切换）
    const uploaded = await this.storageService.upload(
      file.buffer,
      file.originalname,
      `documents/${kbId}`,
    );

    // 3) 创建文档记录（状态 UPLOADED → 等待队列处理）
    const doc = await this.documentService.create({
      knowledgeBaseId: kbId,
      fileName: file.originalname,
      fileType: EXT_TO_TYPE[ext] ?? ext.replace('.', '').toUpperCase(),
      fileSize: uploaded.size,
      storagePath: uploaded.key,
      mimeType: file.mimetype,
      status: 'UPLOADED',
    });

    // 4) 入队 → DocumentProcessor 后台处理
    const job = await this.documentQueue.add(
      'process-document',
      {
        documentId: doc.id,
        knowledgeBaseId: kbId,
        storagePath: uploaded.key,
      },
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 3000,
        },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    );

    return {
      documentId: doc.id,
      jobId: job.id,
      status: 'UPLOADED',
      message: '文件已上传，正在后台处理',
    };
  }

  // ===========================================================================
  // 列表 / 详情 / 状态
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
