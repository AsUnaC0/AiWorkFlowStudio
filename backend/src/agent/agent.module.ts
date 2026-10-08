import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AiModule } from '../ai/ai.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { ToolRegistry } from './tool-registry.service';
import { WorkflowTool } from './tools/workflow.tool';
import { KnowledgeTool } from './tools/knowledge.tool';

/**
 * Agent 模块：ReAct 循环 + Function Calling + 工具注册中心。
 *
 * 依赖：
 *   - AIService（chatWithTools）
 *   - WorkflowEngine（运行已发布工作流）
 *   - KnowledgeRetrievalService（知识库检索）
 *   - PrismaService（Agent CRUD + 读 Workflow.publishedVersion）
 */
@Module({
  imports: [
    PrismaModule,
    forwardRef(() => AiModule),
    forwardRef(() => KnowledgeModule),
    forwardRef(() => WorkflowsModule),
  ],
  controllers: [AgentController],
  providers: [
    AgentService,
    ToolRegistry,
    WorkflowTool,
    KnowledgeTool,
  ],
  exports: [AgentService],
})
export class AgentModule {}
