import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { PrismaModule } from '../prisma/prisma.module';
import {
  WorkflowController,
  WorkflowsController,
} from './workflows.controller';
import { WorkflowsService } from './workflows.service';
import { WorkflowEngine } from './engine/workflow.engine';
import { NodeExecutorRegistry } from './engine/node-executor.registry';
import { InputNodeExecutor } from './engine/executors/input.executor';
import { LLMNodeExecutor } from './engine/executors/llm.executor';
import { OutputNodeExecutor } from './engine/executors/output.executor';
import { StartNodeExecutor } from './engine/executors/start.executor';
import { PromptNodeExecutor } from './engine/executors/prompt.executor';
import { RAGNodeExecutor } from './engine/executors/rag.executor';

@Module({
  imports: [PrismaModule, AuthModule, AiModule, KnowledgeModule],
  controllers: [WorkflowsController, WorkflowController],
  providers: [
    WorkflowsService,
    WorkflowEngine,
    NodeExecutorRegistry,
    StartNodeExecutor,
    InputNodeExecutor,
    LLMNodeExecutor,
    OutputNodeExecutor,
    PromptNodeExecutor,
    RAGNodeExecutor,
  ],
})
export class WorkflowsModule {}
