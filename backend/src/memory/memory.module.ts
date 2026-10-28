import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { LlmConfigModule } from '../llm-config/llm-config.module';
import { MemoryController } from './memory.controller';
import { MemoryService } from './memory.service';
import { MemoryWriterService } from './memory-writer.service';

/**
 * MemoryModule —— 平台助理的对话记忆。
 *
 * 依赖：
 *   - KnowledgeModule 只为拿 EmbeddingService（向量化）。记忆不碰知识库的表，
 *     但向量化能力只有这一份实现，复制一份出来只会分裂。
 *   - LlmConfigModule 用来找用户的 Embedding / 对话模型。
 *   - AIService 是 @Global 的，无需 import。
 *
 * 依赖方向：MemoryModule → KnowledgeModule（单向）。KnowledgeModule 不知道记忆的存在。
 */
@Module({
  imports: [PrismaModule, KnowledgeModule, LlmConfigModule],
  controllers: [MemoryController],
  providers: [MemoryService, MemoryWriterService],
  exports: [MemoryService, MemoryWriterService],
})
export class MemoryModule {}
