import { Module } from '@nestjs/common';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeController } from './knowledge.controller';
import { DocumentsController } from './documents/documents.controller';
import { DocumentService } from './documents/document.service';
import { DocumentParserService } from './documents/document-parser.service';
import { PdfParser } from './documents/parsers/pdf.parser';
import { DocxParser } from './documents/parsers/docx.parser';
import { TxtParser } from './documents/parsers/txt.parser';
import { MarkdownParser } from './documents/parsers/markdown.parser';
import { ChunkService } from './chunk/chunk.service';
import { EmbeddingService } from './embedding/embedding.service';
import { VectorStoreService } from './vector/vector-store.service';
import { KnowledgeRetrievalService } from './retrieval/knowledge-retrieval.service';

@Module({
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
    KnowledgeRetrievalService,
  ],
})
export class KnowledgeModule {}
