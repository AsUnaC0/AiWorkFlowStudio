import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SkillModule } from '../skill/skill.module';
import { McpModule } from '../mcp/mcp.module';
import { LlmConfigModule } from '../llm-config/llm-config.module';
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
import { RunMonitorService } from './engine/run-monitor.service';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    AiModule,
    KnowledgeModule,
    SkillModule,
    McpModule,
    LlmConfigModule,
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
    RunMonitorService,
    StartNodeExecutor,
    InputNodeExecutor,
    LLMNodeExecutor,
    OutputNodeExecutor,
    PromptNodeExecutor,
    RAGNodeExecutor,
    HttpNodeExecutor,
    ConditionNodeExecutor,
  ],
  // WorkflowsService 供平台助理等上层模块复用（含工作空间成员权限校验 + 版本管理）
  exports: [WorkflowEngine, WorkflowsService],
})
export class WorkflowsModule {}
