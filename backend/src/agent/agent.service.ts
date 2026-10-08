import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIService } from '../ai/ai.service';
import type { ChatMessage, ToolCall } from '../ai/ai-provider.interface';
import { ToolRegistry } from './tool-registry.service';

// ===========================================================================
// 类型
// ===========================================================================

/** Agent SSE 事件类型 —— 推给前端 */
export type AgentStreamEvent =
  | { type: 'thinking'; message: string }
  | { type: 'tool_call'; tool: string; args: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; result: string; durationMs: number }
  | { type: 'message'; content: string }
  | { type: 'error'; message: string };

/** 运行时上下文 —— 由前端聊天页动态传入，不再依赖持久化 Agent 记录 */
export interface AgentChatContext {
  /** LLM 模型名 */
  model: string;
  /** 绑定的已发布工作流 ID 列表 */
  workflowIds: string[];
  /** 绑定的知识库 ID 列表 */
  knowledgeBaseIds: string[];
  /** System Prompt（可选） */
  systemPrompt?: string;
  /** 温度，默认 0.7 */
  temperature?: number;
  /** ReAct 循环上限，默认 10 */
  maxToolIterations?: number;
}

/** Agent 运行选项 */
export interface AgentRunOptions {
  input: string;
  history?: ChatMessage[];
}

@Injectable()
export class AgentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiService: AIService,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  // ===========================================================================
  // 资源查询（前端聊天页下拉用）
  // ===========================================================================

  /**
   * 返回当前用户有权限访问的：
   *   - 已发布工作流（PUBLISHED）
   *   - 知识库
   * 用 workspace member 权限过滤。
   */
  async getAvailableResources(userId: string) {
    const [workflows, knowledgeBases] = await Promise.all([
      this.prisma.workflow.findMany({
        where: {
          status: 'PUBLISHED',
          workspace: {
            OR: [{ ownerId: userId }, { members: { some: { userId } } }],
          },
        },
        select: {
          id: true,
          name: true,
          description: true,
          publishedVersion: { select: { version: true } },
        },
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.knowledgeBase.findMany({
        where: {
          OR: [
            { ownerId: userId },
            {
              workspaces: {
                some: {
                  workspace: {
                    OR: [
                      { ownerId: userId },
                      { members: { some: { userId } } },
                    ],
                  },
                },
              },
            },
          ],
        },
        select: {
          id: true,
          name: true,
          description: true,
          documentCount: true,
          chunkCount: true,
        },
        orderBy: { updatedAt: 'desc' },
      }),
    ]);

    return { workflows, knowledgeBases };
  }

  // ===========================================================================
  // 核心：ReAct 循环
  // ===========================================================================

  /**
   * 同步运行（测试用）。
   */
  async run(userId: string, ctx: AgentChatContext, options: AgentRunOptions) {
    const { tools, messages } = await this.prepareRun(ctx, options);

    let currentMessages = messages;
    const maxIters = ctx.maxToolIterations ?? 10;

    for (let i = 0; i < maxIters; i++) {
      const result = await this.aiService.chatWithTools(
        currentMessages,
        { model: ctx.model, temperature: ctx.temperature ?? 0.7 },
        tools,
      );

      if (result.toolCalls.length === 0) {
        return {
          answer: result.content,
          iterations: i + 1,
          usage: result.usage,
        };
      }

      currentMessages = await this.handleToolCalls(
        result.toolCalls,
        currentMessages,
        ctx,
        userId,
      );
    }

    return {
      answer: 'Agent 达到最大工具调用次数限制',
      iterations: maxIters,
    };
  }

  /**
   * 流式运行 —— SSE 事件生成器。
   * 前端聊天页直接调这个。
   */
  async *runStream(
    userId: string,
    ctx: AgentChatContext,
    options: AgentRunOptions,
  ): AsyncGenerator<AgentStreamEvent> {
    const { tools, messages } = await this.prepareRun(ctx, options);

    let currentMessages = messages;
    const maxIters = ctx.maxToolIterations ?? 10;

    for (let i = 0; i < maxIters; i++) {
      yield { type: 'thinking', message: `思考中... (第 ${i + 1} 轮)` };

      const result = await this.aiService.chatWithTools(
        currentMessages,
        { model: ctx.model, temperature: ctx.temperature ?? 0.7 },
        tools,
      );

      // LLM 直接回答
      if (result.toolCalls.length === 0) {
        yield { type: 'message', content: result.content };
        return;
      }

      // 有 tool_calls → emit + execute + 喂回
      // 先把 assistant 消息（含 tool_calls）塞回 messages
      currentMessages.push({
        role: 'assistant',
        content: result.content,
        tool_calls: result.toolCalls,
      });

      for (const tc of result.toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          args = { raw: tc.function.arguments };
        }

        yield { type: 'tool_call', tool: tc.function.name, args };

        const toolStart = Date.now();
        let toolResult = '';
        try {
          toolResult = await this.toolRegistry.executeTool(
            tc.function.name,
            args,
            {
              agentId: '',
              userId,
              knowledgeBaseIds: ctx.knowledgeBaseIds,
            },
          );
        } catch (err) {
          toolResult = `工具执行错误：${err instanceof Error ? err.message : String(err)}`;
        }
        const durationMs = Date.now() - toolStart;

        yield {
          type: 'tool_result',
          tool: tc.function.name,
          result: toolResult,
          durationMs,
        };

        currentMessages.push({
          role: 'tool',
          content: toolResult,
          tool_call_id: tc.id,
        });
      }
    }

    yield { type: 'error', message: 'Agent 达到最大工具调用次数限制' };
  }

  // ===========================================================================
  // 内部辅助
  // ===========================================================================

  private async prepareRun(ctx: AgentChatContext, options: AgentRunOptions) {
    // 1. 动态构建工具定义（根据前端选了哪些 workflowIds / knowledgeBaseIds）
    const tools = await this.toolRegistry.buildDefinitions(
      ctx.workflowIds,
      ctx.knowledgeBaseIds,
    );

    // 2. 初始化 messages
    const messages: ChatMessage[] = [];
    if (ctx.systemPrompt) {
      messages.push({ role: 'system', content: ctx.systemPrompt });
    }
    if (options.history?.length) {
      messages.push(...options.history);
    }
    messages.push({ role: 'user', content: options.input });

    return { tools, messages };
  }

  private async handleToolCalls(
    toolCalls: ToolCall[],
    currentMessages: ChatMessage[],
    ctx: AgentChatContext,
    userId: string,
  ): Promise<ChatMessage[]> {
    const newMessages: ChatMessage[] = [
      ...currentMessages,
      { role: 'assistant', content: '', tool_calls: toolCalls },
    ];

    for (const tc of toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        args = { raw: tc.function.arguments };
      }

      let result = '';
      try {
        result = await this.toolRegistry.executeTool(tc.function.name, args, {
          agentId: '',
          userId,
          knowledgeBaseIds: ctx.knowledgeBaseIds,
        });
      } catch (err) {
        result = `工具执行错误：${err instanceof Error ? err.message : String(err)}`;
      }

      newMessages.push({
        role: 'tool',
        content: result,
        tool_call_id: tc.id,
      });
    }

    return newMessages;
  }
}
