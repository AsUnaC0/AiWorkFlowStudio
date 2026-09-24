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
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentService } from './document.service';
import { DocumentParserService } from './document-parser.service';
import { ChunkService } from './chunk/chunk.service';
import { EmbeddingService } from '../embedding/embedding.service';
import { VectorStoreService } from '../vector/vector-store.service';

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
    private readonly embeddingService: EmbeddingService,
    private readonly vectorStoreService: VectorStoreService,
    private readonly prisma: PrismaService,
  ) {}

  // ===========================================================================
  // 上传
  // ===========================================================================

  /** 上传文档到指定知识库 → 解析 → 分块 → 向量化 → COMPLETED */
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

    // 2) 落盘
    const documentId = crypto.randomUUID();
    const storageDir = join(UPLOAD_DIR, kbId);
    const storagePath = join(storageDir, `${documentId}${ext}`);

    await mkdir(storageDir, { recursive: true });
    await writeFile(storagePath, file.buffer);

    // 3) 创建文档记录（状态 PROCESSING）
    const doc = await this.documentService.create({
      knowledgeBaseId: kbId,
      fileName: file.originalname,
      fileType: EXT_TO_TYPE[ext] ?? ext.replace('.', '').toUpperCase(),
      fileSize: file.size,
      storagePath,
      mimeType: file.mimetype,
      status: 'PROCESSING',
    });

    // 4) 同步处理管线：解析 → 分块 → 向量化
    try {
      // 4a. 查知识库配置的 embeddingModel（向量化时必须知道用哪个模型）
      const kb = await this.prisma.knowledgeBase.findUnique({
        where: { id: kbId },
        select: { embeddingModel: true },
      });
      if (!kb) throw new HttpException('知识库不存在', HttpStatus.NOT_FOUND);

      // 4b. 解析 → 纯文本
      const text = await this.documentParserService.parse(storagePath);

      // 4c. 分块 → 入库
      const chunks = await this.chunkService.split(text);
      await this.chunkService.createMany(doc.id, kbId, chunks);

      // 4d. 取刚写入的 chunk（此时 embedding 都是 null）
      const storedChunks = await this.prisma.documentChunk.findMany({
        where: { documentId: doc.id },
        select: { id: true, content: true },
      });

      // 4e. 批量向量化
      if (storedChunks.length > 0) {
        const vectors = await this.embeddingService.embedBatch(
          storedChunks.map((c) => c.content),
          kb.embeddingModel,
        );

        // 4f. 批量写 pgvector 列
        const pairs = storedChunks.map((c, i) => ({
          chunkId: c.id,
          vector: vectors[i],
        }));
        await this.vectorStoreService.updateEmbeddingBatch(pairs);
      }

      // 5) 全部成功 → COMPLETED
      await this.documentService.updateStatus(doc.id, 'COMPLETED');
    } catch (err) {
      const message = err instanceof Error ? err.message : '未知解析错误';
      await this.documentService.updateStatus(doc.id, 'FAILED', message);
      throw new HttpException(
        `文档处理失败：${message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

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
