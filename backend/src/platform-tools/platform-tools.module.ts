import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { ChatFilesModule } from '../chat-files/chat-files.module';
import { LlmConfigModule } from '../llm-config/llm-config.module';
import { McpModule } from '../mcp/mcp.module';
import { SkillModule } from '../skill/skill.module';
import { PlatformToolsService } from './platform-tools.service';
import { PlatformOperationLogService } from './platform-operation-log.service';
import { UserTools } from './tools/user.tools';
import { WorkspaceTools } from './tools/workspace.tools';
import { WorkflowTools } from './tools/workflow.tools';
import { KnowledgeTools } from './tools/knowledge.tools';
import { AgentTools } from './tools/agent.tools';
import { SkillMcpTools } from './tools/skill-mcp.tools';

/**
 * PlatformTools 模块 —— 平台内置工具集合。
 *
 * 设计原则（对应架构约束「平台助理可以拥有平台操作能力，
 * 但不能绕过业务 Service，更不能仅凭模型判断直接改库」）：
 *
 *   PlatformTool（工具层）
 *        ↓ 只调用
 *   既有业务 Service（WorkflowsService / KnowledgeService / DocumentService / StorageService …）
 *        ↓
 *   Prisma / BullMQ
 *
 *   - 工具全部由后端注册，用户无法通过聊天消息临时定义
 *   - 每个工具自带输入 Schema、权限校验与结构化结果
 *   - 跨用户访问一律拒绝：userId 只来自认证上下文
 *
 * 注意：这里刻意**不依赖 AgentModule**，避免
 *   AgentModule → AssistantModule → PlatformToolsModule → AgentModule 的循环依赖。
 * 新增的 McpModule / SkillModule 都是叶子模块（只依赖 PrismaModule），不会形成环。
 */
@Module({
  imports: [
    PrismaModule,
    StorageModule,
    KnowledgeModule,
    WorkflowsModule,
    ChatFilesModule,
    LlmConfigModule,
    // 创建 MCP Server / Skill 需要复用业务 Service，而不是工具层直接写 Prisma
    McpModule,
    SkillModule,
    // 文档处理队列（把聊天附件加入知识库时投递解析任务）
    BullModule.registerQueue({ name: 'document-processing' }),
  ],
  providers: [
    PlatformToolsService,
    PlatformOperationLogService,
    UserTools,
    WorkspaceTools,
    WorkflowTools,
    KnowledgeTools,
    AgentTools,
    SkillMcpTools,
  ],
  exports: [PlatformToolsService, PlatformOperationLogService],
})
export class PlatformToolsModule {}
