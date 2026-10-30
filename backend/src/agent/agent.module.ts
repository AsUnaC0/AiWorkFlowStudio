import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AiModule } from '../ai/ai.module';
import { FilesModule } from '../files/files.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { LlmConfigModule } from '../llm-config/llm-config.module';
import { ChatFilesModule } from '../chat-files/chat-files.module';
import { McpModule } from '../mcp/mcp.module';
import { AssistantModule } from '../assistant/assistant.module';
import { PersonaModule } from '../persona/persona.module';
import { MemoryModule } from '../memory/memory.module';
import { SkillModule } from '../skill/skill.module';
import { WebSearchModule } from '../web-search/web-search.module';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { ChatSessionService } from './chat-session.service';
import { ToolRegistry } from './tool-registry.service';
import { WorkflowTool } from './tools/workflow.tool';
import { KnowledgeTool } from './tools/knowledge.tool';
import { GenerateFileTool } from './tools/generate-file.tool';
import { WebSearchTool } from './tools/web-search.tool';

/**
 * Agent 模块：
 *   - Agent CRUD（创建/查询/更新/删除 Agent）
 *   - ChatSession + ChatMessage（会话隔离 + 消息持久化）
 *   - ReAct 循环 + Function Calling + 工具注册中心
 *   - generate_file 工具（产出 Word / Excel / PDF / Markdown 文件）
 *
 * 依赖：
 *   - AIService（chatWithTools）
 *   - WorkflowEngine（运行已发布工作流）
 *   - KnowledgeRetrievalService（知识库检索）
 *   - FilesService（文件生成 / 存储 / 预览）
 *   - PrismaService（Agent CRUD + ChatSession + ChatMessage）
 */
@Module({
  imports: [
    PrismaModule,
    forwardRef(() => AiModule),
    forwardRef(() => KnowledgeModule),
    forwardRef(() => WorkflowsModule),
    LlmConfigModule,
    FilesModule,
    // MCP 工具调用（McpService 取配置、McpToolService 做工具发现与调用）
    McpModule,
    // 聊天附件上传/解析/上下文组装（ChatFilesService、FileContextService）
    ChatFilesModule,
    // 平台助理（默认系统 Agent 的专属 Prompt / 平台工具注册中心 / 操作审计）
    AssistantModule,
    // 人格表达层（runStream 装配 System Prompt 时读取）
    PersonaModule,
    // 对话记忆（召回注入 + 结束后异步沉淀）
    MemoryModule,
    // Skill 定义（绑定的 instructions 拼进 System Prompt）
    // 只依赖 PrismaModule，不会和 AgentModule 形成循环
    SkillModule,
    // 联网搜索（web_search 内置工具；只读环境变量，不碰数据库）
    WebSearchModule,
  ],
  controllers: [AgentController],
  providers: [
    AgentService,
    ChatSessionService,
    ToolRegistry,
    WorkflowTool,
    KnowledgeTool,
    GenerateFileTool,
    WebSearchTool,
  ],
  exports: [AgentService, ChatSessionService],
})
export class AgentModule {}
