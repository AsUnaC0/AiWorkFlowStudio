import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
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
import { HttpNodeExecutor } from './engine/executors/http.executor';
import { ConditionNodeExecutor } from './engine/executors/condition.executor';
import { VariableService } from './engine/variable.service';
import { SsrfCheckService } from './engine/ssrf-check.service';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    AiModule,
    KnowledgeModule,
    BullModule.registerQueue({
      name: 'workflow-execution',
    }),
  ],
  controllers: [WorkflowsController, WorkflowController],
  providers: [
    WorkflowsService,
    WorkflowEngine,
    NodeExecutorRegistry,
    VariableService,
    SsrfCheckService,
    StartNodeExecutor,
    InputNodeExecutor,
    LLMNodeExecutor,
    OutputNodeExecutor,
    PromptNodeExecutor,
    RAGNodeExecutor,
    HttpNodeExecutor,
    ConditionNodeExecutor,
  ],
  exports: [WorkflowEngine],
})
export class WorkflowsModule {}
