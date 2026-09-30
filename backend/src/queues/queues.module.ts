import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { DocumentProcessor } from './document-processing/document.processor';
import { WorkflowProcessor } from './workflow-execution/workflow.processor';

/**
 * 统一的异步任务模块 —— 聚合所有 BullMQ Processor
 *
 * 目录结构：
 * queues/
 *   document-processing/    ← 文档处理队列（上传 → 解析 → 分块 → Embedding → pgvector）
 *     document.processor.ts
 *   workflow-execution/     ← 工作流执行队列（运行 → WorkflowEngine → 持久化结果）
 *     workflow.processor.ts
 *   queues.module.ts
 */
@Module({
  imports: [PrismaModule, KnowledgeModule, WorkflowsModule],
  providers: [DocumentProcessor, WorkflowProcessor],
})
export class QueuesModule {}
