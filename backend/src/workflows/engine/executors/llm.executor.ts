import { Injectable } from '@nestjs/common';
import { AIService } from '../../../ai/ai.service';
import type {
  ChatMessage,
  ChatOptions,
  ToolDefinition,
} from '../../../ai/ai-provider.interface';
import { NodeExecutionContext } from '../node-executor.interface';
import { VariableService } from '../variable.service';
import { KnowledgeRetrievalService } from '../../../knowledge/retrieval/knowledge-retrieval.service';
import type { SearchMode } from '../../../knowledge/retrieval/types';
import { SkillService } from '../../../skill/skill.service';
import { McpService } from '../../../mcp/mcp.service';

/** LLM 节点配置（v1.5：含 Skill/MCP 工具调用） */
interface LlmNodeConfig {
  // 基础配置
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** System Prompt，支持 {{变量}} 引用 */
  prompt?: string;
  /** User Prompt，留空则用 previousOutput；支持 {{变量}} */
  userPrompt?: string;

  // 知识库配置（简单模式，v1.3/v1.4）
  /** 是否启用知识库检索（简单模式 RAG） */
  enableRag?: boolean;
  /** 关联知识库 ID 列表 */
  knowledgeBaseIds?: string[];
  /** 检索 Top K，默认 5 */
  topK?: number;
  /** 相似度阈值 0~1，默认 0.7 */
  similarityThreshold?: number;
  /** 检索模式，默认 hybrid */
  searchMode?: SearchMode;
  /** Embedding 模型；不传则用知识库绑定模型 */
  embeddingModel?: string;

  // Skill / MCP 配置（v1.5）
  /** 关联 Skill ID 列表，其 instructions 注入 System Prompt */
  skillIds?: string[];
  /** 关联 MCP Server ID 列表，其 tools 作为 LLM 可用工具 */
  mcpServerIds?: string[];
}

@Injectable()
export class LLMNodeExecutor {
  constructor(
    private readonly aiService: AIService,
    private readonly variableService: VariableService,
    private readonly knowledgeRetrievalService: KnowledgeRetrievalService,
    private readonly skillService: SkillService,
    private readonly mcpService: McpService,
  ) {}

  async execute(context: NodeExecutionContext, node: any) {
    const { messages, options, tools, mcpServerMap } = await this.createParams(
      context,
      node,
    );

    // 有 MCP 工具 → 走 chatWithTools 循环
    if (tools && tools.length > 0) {
      return await this.executeWithTools(
        messages,
        options,
        tools,
        mcpServerMap,
      );
    }

    const result = await this.aiService.chat(messages, options);
    return { output: result.content };
  }

  async *executeStream(
    context: NodeExecutionContext,
    node: any,
  ): AsyncGenerator<string> {
    const { messages, options } = await this.createParams(context, node);
    for await (const chunk of this.aiService.streamChat(messages, options)) {
      yield chunk;
    }
  }

  /**
   * 带工具的 LLM 执行循环：
   * 1. 调 chatWithTools → LLM 可能返回 content 或 toolCalls
   * 2. 如果返回 toolCalls → 执行工具 → 把结果追加到 messages → 再次调 chatWithTools
   * 3. 最多循环 5 轮，防止无限调用
   */
  private async executeWithTools(
    messages: ChatMessage[],
    options: ChatOptions,
    tools: ToolDefinition[],
    mcpServerMap: Map<
      string,
      {
        transport: string;
        serverUrl: string;
        authType: string;
        credentials: unknown;
      }
    >,
  ) {
    const MAX_ROUNDS = 5;
    let currentMessages = [...messages];

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const result = await this.aiService.chatWithTools(
        currentMessages,
        options,
        tools,
      );

      // LLM 直接回答 → 返回
      if (result.content && result.toolCalls.length === 0) {
        return { output: result.content };
      }

      // LLM 请求调用工具 → 执行并继续
      if (result.toolCalls.length > 0) {
        // 把 assistant 的 tool_calls 消息加入上下文
        currentMessages.push({
          role: 'assistant',
          content: result.content || '',
          tool_calls: result.toolCalls,
        });

        // 执行每个工具调用
        for (const call of result.toolCalls) {
          const server = mcpServerMap.get(call.function.name);
          if (!server) {
            currentMessages.push({
              role: 'tool',
              content: `工具 "${call.function.name}" 未找到对应的 MCP Server`,
              tool_call_id: call.id,
            });
            continue;
          }

          try {
            const args = JSON.parse(call.function.arguments || '{}');
            const toolResult = await this.mcpService.callTool(
              server,
              call.function.name,
              args,
            );
            currentMessages.push({
              role: 'tool',
              content:
                typeof toolResult === 'string'
                  ? toolResult
                  : JSON.stringify(toolResult),
              tool_call_id: call.id,
            });
          } catch (err) {
            currentMessages.push({
              role: 'tool',
              content: `工具执行失败: ${err instanceof Error ? err.message : String(err)}`,
              tool_call_id: call.id,
            });
          }
        }
        // 继续下一轮，让 LLM 看到工具结果后再决定
        continue;
      }

      // 无 content 也无 toolCalls → 返回空
      return { output: '' };
    }

    return { output: '（工具调用轮次已达上限）' };
  }

  /**
   * 构造 LLM 调用参数。
   * v1.5：Skill instructions 注入 System Prompt；MCP tools 作为工具定义。
   */
  private async createParams(
    context: NodeExecutionContext,
    node: any,
  ): Promise<{
    messages: ChatMessage[];
    options: ChatOptions;
    tools: ToolDefinition[];
    mcpServerMap: Map<
      string,
      {
        transport: string;
        serverUrl: string;
        authType: string;
        credentials: unknown;
      }
    >;
  }> {
    const config = (node.config ?? {}) as LlmNodeConfig;

    // system prompt 支持 {{变量}} 引用
    const rawSystemPrompt = String(config.prompt ?? '');
    const systemPrompt = String(
      this.variableService.resolve(rawSystemPrompt, context) ?? '',
    );

    // user input：优先用 userPrompt，也支持 {{变量}} 模板
    const rawUserInput = String(
      config.userPrompt ?? context.previousOutput ?? context.input ?? '',
    );
    const userInput = String(
      this.variableService.resolve(rawUserInput, context) ?? '',
    );

    // ------------------------------------------------------------------
    // Skill 注入：把选中 Skill 的 instructions 追加到 System Prompt
    // ------------------------------------------------------------------
    let skillInstructions = '';
    if (Array.isArray(config.skillIds) && config.skillIds.length > 0) {
      const skills = await this.skillService.findByIds(config.skillIds);
      const validSkills = skills.filter((s) => s.instructions);
      if (validSkills.length > 0) {
        skillInstructions = validSkills
          .map((s) => `## Skill: ${s.name}\n${s.instructions}`)
          .join('\n\n');
      }
    }

    // ------------------------------------------------------------------
    // RAG 简单模式：检索 → 注入 {{rag_context}}
    // ------------------------------------------------------------------
    let finalSystemPrompt = systemPrompt;

    if (
      config.enableRag &&
      Array.isArray(config.knowledgeBaseIds) &&
      config.knowledgeBaseIds.length > 0
    ) {
      const query = userInput || systemPrompt;
      const results = await this.knowledgeRetrievalService.search({
        knowledgeBaseIds: config.knowledgeBaseIds,
        query,
        topK: config.topK ?? 5,
        scoreThreshold: config.similarityThreshold ?? 0.7,
        mode: config.searchMode ?? 'hybrid',
        embeddingModel: config.embeddingModel,
      });

      const ragContext =
        results.length > 0
          ? results
              .map(
                (r, i) =>
                  `[${i + 1}]${
                    r.fileName ? ` 来源：${r.fileName}` : ''
                  }\n${r.content}`,
              )
              .join('\n\n')
          : '（未检索到相关内容）';

      // 优先替换 System Prompt 里的 {{rag_context}} 占位符
      if (/\{\{rag_context\}\}/.test(rawSystemPrompt)) {
        // 把 rag_context 注入 context.data，让 VariableService 能解析
        const enrichedContext = {
          ...context,
          data: {
            ...(context.data ?? {}),
            rag_context: ragContext,
          },
        };
        finalSystemPrompt = String(
          this.variableService.resolve(rawSystemPrompt, enrichedContext) ?? '',
        );
      } else if (systemPrompt) {
        // 没有占位符但有 System Prompt → 自动追加知识库参考
        finalSystemPrompt = `${systemPrompt}\n\n知识库参考：\n${ragContext}`;
      } else {
        // 既没占位符也没 System Prompt → 用默认模板
        finalSystemPrompt = `请基于以下知识库内容回答用户问题。如果检索内容中没有相关信息，请坦诚说明。\n\n${ragContext}`;
      }

      console.log(
        '[LLM] RAG 简单模式：命中',
        results.length,
        '条，已注入上下文',
      );
    }

    // ------------------------------------------------------------------
    // 追加 Skill instructions 到 System Prompt
    // ------------------------------------------------------------------
    if (skillInstructions) {
      finalSystemPrompt = finalSystemPrompt
        ? `${finalSystemPrompt}\n\n--- Skills ---\n${skillInstructions}`
        : `--- Skills ---\n${skillInstructions}`;
    }

    const messages: ChatMessage[] = [];
    if (finalSystemPrompt) {
      messages.push({ role: 'system', content: finalSystemPrompt });
    }
    messages.push({ role: 'user', content: userInput });

    // ------------------------------------------------------------------
    // MCP 工具定义：从选中 MCP Server 的 availableTools 构建
    // ------------------------------------------------------------------
    const tools: ToolDefinition[] = [];
    const mcpServerMap = new Map<
      string,
      {
        transport: string;
        serverUrl: string;
        authType: string;
        credentials: unknown;
      }
    >();

    if (Array.isArray(config.mcpServerIds) && config.mcpServerIds.length > 0) {
      const servers = await this.mcpService.findByIds(config.mcpServerIds);
      for (const server of servers) {
        const serverInfo = {
          transport: server.transport,
          serverUrl: server.serverUrl,
          authType: server.authType,
          credentials: server.credentials,
        };

        const availableTools =
          (server.availableTools as Array<{
            name: string;
            description?: string;
            inputSchema?: {
              type: string;
              properties?: Record<string, unknown>;
              required?: string[];
            };
          }> | null) ?? [];

        for (const tool of availableTools) {
          tools.push({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description ?? '',
              parameters:
                tool.inputSchema && typeof tool.inputSchema === 'object'
                  ? {
                      type: 'object' as const,
                      properties:
                        (tool.inputSchema.properties as Record<
                          string,
                          {
                            type: string;
                            description?: string;
                            enum?: string[];
                            items?: Record<string, unknown>;
                          }
                        >) ?? {},
                      required: tool.inputSchema.required ?? [],
                    }
                  : undefined,
            },
          });
          // 映射 tool name → server（用于执行时查找）
          mcpServerMap.set(tool.name, serverInfo);
        }
      }

      if (tools.length > 0) {
        console.log(
          `[LLM] 已加载 ${tools.length} 个 MCP 工具，来自 ${mcpServerMap.size} 个 Server`,
        );
      }
    }

    return {
      messages,
      options: {
        model: config.model ?? 'qwen2.5:7b',
        temperature: config.temperature,
        maxTokens: config.maxTokens,
      },
      tools,
      mcpServerMap,
    };
  }
}
