import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module';
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
import { VectorStoreService } from './vector/vector-store.service';
import { KnowledgeRetrievalService } from './retrieval/knowledge-retrieval.service';

@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue({
      name: 'document-processing',
    }),
  ],
  controllers: [KnowledgeController, DocumentsController],
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
  ],
})
export class KnowledgeModule {}
