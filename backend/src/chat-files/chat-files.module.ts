import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { FilesModule } from '../files/files.module';
import { ChatFilesController } from './chat-files.controller';
import { ChatFilesService, CHAT_FILE_QUEUE } from './chat-files.service';
import { FileParserService } from './file-parser.service';
import { FileContextService } from './file-context.service';
import { ChatFileProcessingProcessor } from './chat-file-processing.processor';
import { TextParser } from './parsers/text.parser';
import { PdfParser } from './parsers/pdf.parser';
import { DocxParser } from './parsers/docx.parser';
import { ExcelParser } from './parsers/excel.parser';
import { CsvParser } from './parsers/csv.parser';
import { ImageParser } from './parsers/image.parser';

/**
 * ChatFiles 模块 —— 聊天输入附件的「上传 / 解析 / 上下文组装」。与知识库 Document
 * 完全解耦：附件不会被向量化，也不会自动进知识库，拥有独立的生命周期与权限。
 *
 * 复用：
 *   - StorageService（七牛云 / 本地对象存储）
 *   - FilesModule 的 FilePreviewService（预览渲染，复用文档/表格/PDF 预览能力）
 *   - BullMQ（chat-file-processing 队列执行异步解析）
 */
@Module({
  imports: [
    PrismaModule,
    StorageModule,
    FilesModule,
    BullModule.registerQueue({ name: CHAT_FILE_QUEUE }),
  ],
  controllers: [ChatFilesController],
  providers: [
    ChatFilesService,
    FileParserService,
    FileContextService,
    ChatFileProcessingProcessor,
    TextParser,
    PdfParser,
    DocxParser,
    ExcelParser,
    CsvParser,
    ImageParser,
  ],
  exports: [ChatFilesService, FileContextService],
})
export class ChatFilesModule {}
