import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AiModule } from '../ai/ai.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { ChatSessionService } from './chat-session.service';
import { ToolRegistry } from './tool-registry.service';
import { WorkflowTool } from './tools/workflow.tool';
import { KnowledgeTool } from './tools/knowledge.tool';

/**
 * Agent 模块：
 *   - Agent CRUD（创建/查询/更新/删除 Agent）
 *   - ChatSession + ChatMessage（会话隔离 + 消息持久化）
 *   - ReAct 循环 + Function Calling + 工具注册中心
 *
 * 依赖：
 *   - AIService（chatWithTools）
 *   - WorkflowEngine（运行已发布工作流）
 *   - KnowledgeRetrievalService（知识库检索）
 *   - PrismaService（Agent CRUD + ChatSession + ChatMessage）
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
    ChatSessionService,
    ToolRegistry,
    WorkflowTool,
    KnowledgeTool,
  ],
  exports: [AgentService, ChatSessionService],
})
export class AgentModule {}
