import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { LlmConfigModule } from '../llm-config/llm-config.module';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeController } from './knowledge.controller';
import { DocumentsController } from './documents/documents.controller';
import { DocumentService } from './documents/document.service';
import { DocumentParserService } from './documents/document-parser.service';
import { PdfParser } from './documents/parsers/pdf.parser';
import { DocxParser } from './documents/parsers/docx.parser';
import { TxtParser } from './documents/parsers/txt.parser';
import { MarkdownParser } from './documents/parsers/markdown.parser';
import { ChunkService } from './documents/chunk/chunk.service';
import { EmbeddingService } from './embedding/embedding.service';
import { EmbeddingVersionService } from './embedding/embedding-version.service';
import { EmbeddingVersionController } from './embedding/embedding-version.controller';
import { VectorStoreService } from './vector/vector-store.service';
import { KnowledgeRetrievalService } from './retrieval/knowledge-retrieval.service';

@Module({
  imports: [
    PrismaModule,
    StorageModule,
    LlmConfigModule,
    BullModule.registerQueue({
      name: 'document-processing',
    }),
    BullModule.registerQueue({
      name: 'knowledge-reembed',
    }),
  ],
  controllers: [
    KnowledgeController,
    DocumentsController,
    EmbeddingVersionController,
  ],
  providers: [
    KnowledgeService,
    DocumentService,
    DocumentParserService,
    PdfParser,
    DocxParser,
    TxtParser,
    MarkdownParser,
    ChunkService,
    EmbeddingService,
    EmbeddingVersionService,
    VectorStoreService,
    KnowledgeRetrievalService,
  ],
  exports: [
    KnowledgeService,
    DocumentService,
    DocumentParserService,
    ChunkService,
    KnowledgeRetrievalService,
    VectorStoreService,
    EmbeddingService,
    EmbeddingVersionService,
  ],
})
export class KnowledgeModule {}
