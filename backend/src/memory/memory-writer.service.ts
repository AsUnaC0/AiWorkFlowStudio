import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type {
  AiProvider,
  ChatMessage,
  ModelCallTelemetry,
} from '../ai/ai-provider.interface';
import { normalizeContentToString } from '../ai/content.util';
import { MemoryService } from './memory.service';
import {
  CAPTURE_COOLDOWN_MS,
  MAX_CAPTURE_PER_TURN,
  SUMMARY_MAX_LENGTH,
  containsSensitiveInfo,
  isMemoryCategory,
  truncateSummary,
} from './memory.constant';

/** 抽取时读取的最近消息条数 */
const RECENT_MESSAGE_LIMIT = 6;

/** 抽取 Prompt —— 只做一件事：把对话变成结构化记忆候选 */
const CAPTURE_PROMPT = `你是一个记忆抽取器。下面会给你一段用户与助理的最近对话，请从中抽取**值得长期记住**的信息。

抽取规则：
1. 只抽取用户明确表达或确认过的内容：偏好、事实、正在进行的任务、重要事件、情绪倾向。
2. 不要抽取：一次性的提问、助理自己说的话、工具返回的原始数据、任何形式的寒暄。
3. 绝对不要抽取密码、密钥、令牌、身份证号、银行卡号等敏感信息（遇到就整条跳过）。
4. 每条 summary 不超过 60 字，是对内容的一句话概括；content 保留必要的细节原文。
5. 没有值得记住的内容时，返回空数组 []。

category 只能取以下值之一：
- PREFERENCE：用户的偏好、习惯、口味、工作方式
- FACT：关于用户的客观事实（身份、技术栈、项目情况）
- TASK：用户正在进行或计划中的任务
- EVENT：发生过的具体事件（时间、结果）
- EMOTION：用户表达的情绪状态或对某事的感受
- OTHER：其它值得记住的内容

importance 取 0~1：0.3 琐碎、0.5 一般、0.7 重要、0.9 关键。

只输出严格的 JSON 数组，不要任何解释、不要 Markdown 代码块、不要注释：
[{"category":"PREFERENCE","summary":"...","content":"...","importance":0.6}]`;

interface CapturedMemory {
  category: string;
  summary: string;
  content: string;
  importance: number;
}

/**
 * MemoryWriterService —— 对话结束后异步沉淀记忆。
 *
 * 设计要点（都为了「不拖慢对话、不写脏数据」）：
 *   1. 调用方 fire-and-forget，**不 await**，任何异常只记 warn。
 *   2. 冷却：同一会话 3 分钟内最多抽取一次，避免每轮对话都多一次模型调用。
 *   3. 模型输出的 JSON 必须逐字段校验后才落库 —— 模型会返回 markdown 包裹、
 *      多余字段、非法 category，这些一律在 parseAndValidate 里挡掉。
 *   4. 敏感信息整条丢弃，不做脱敏保留。
 */
@Injectable()
export class MemoryWriterService {
  private readonly logger = new Logger(MemoryWriterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly memoryService: MemoryService,
  ) {}

  /**
   * 尝试沉淀记忆。
   *
   * @param provider 本次对话实际使用的 Provider（复用，避免重复解析模型配置）
   * @param model    本次对话实际使用的模型名
   */
  async maybeCapture(input: {
    userId: string;
    agentId: string;
    sessionId: string;
    provider: AiProvider;
    model: string;
    telemetry?: ModelCallTelemetry;
  }): Promise<void> {
    try {
      const settings = await this.memoryService.getSettings(input.userId);
      if (!settings.autoCaptureEnabled) return;

      // 冷却：同会话 3 分钟内已抽过就跳过
      const latest = await this.prisma.memory.findFirst({
        where: {
          userId: input.userId,
          sourceConversationId: input.sessionId,
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (
        latest &&
        Date.now() - latest.createdAt.getTime() < CAPTURE_COOLDOWN_MS
      ) {
        return;
      }

      const messages = await this.prisma.chatMessage.findMany({
        where: {
          sessionId: input.sessionId,
          role: { in: ['user', 'assistant'] },
        },
        orderBy: { createdAt: 'desc' },
        take: RECENT_MESSAGE_LIMIT,
        select: { id: true, role: true, content: true },
      });
      if (messages.length < 2) return;

      const transcript = messages
        .reverse()
        .map((m) => `${m.role === 'user' ? '用户' : '助理'}：${m.content}`)
        .join('\n');
      if (transcript.trim().length < 20) return;

      const chatMessages: ChatMessage[] = [
        { role: 'system', content: CAPTURE_PROMPT },
        { role: 'user', content: transcript },
      ];

      const startedAt = Date.now();
      const result = await input.provider.chat(chatMessages, {
        model: input.model,
        temperature: 0.1,
      });
      const raw = normalizeContentToString(result.content);

      this.logger.debug(
        `记忆抽取完成：session=${input.sessionId} ${Date.now() - startedAt}ms`,
      );

      const candidates = this.parseAndValidate(raw);
      if (candidates.length === 0) return;

      let created = 0;
      for (const candidate of candidates) {
        const exists = await this.prisma.memory.findFirst({
          where: { userId: input.userId, summary: candidate.summary },
          select: { id: true },
        });
        if (exists) continue;

        const memory = await this.memoryService.create({
          userId: input.userId,
          agentId: input.agentId,
          category: candidate.category,
          summary: candidate.summary,
          content: candidate.content,
          importance: candidate.importance,
          sourceConversationId: input.sessionId,
          sourceMessageId: messages[messages.length - 1]?.id,
        });
        await this.memoryService.buildLinks(input.userId, {
          id: memory.id,
          category: memory.category,
          embedding: memory.embedding,
        });
        created++;
      }

      if (created > 0) {
        this.logger.log(
          `沉淀 ${created} 条记忆（用户 ${input.userId} / 会话 ${input.sessionId}）`,
        );
      }
    } catch (e) {
      // 记忆沉淀失败绝不能影响对话主流程
      this.logger.warn(
        `记忆沉淀失败（已忽略）：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * 解析并校验模型输出。
   *
   * 模型常见的不规矩输出都在这里处理：
   *   - ```json 代码块包裹 → 先剥壳
   *   - 前后带解释文字 → 取第一个 [ 到最后一个 ]
   *   - category 不在白名单 → 归到 OTHER（而不是整条丢弃）
   *   - 缺字段 / 类型不对 → 丢弃该条
   */
  private parseAndValidate(raw: string): CapturedMemory[] {
    const jsonText = extractJsonArray(raw);
    if (!jsonText) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      this.logger.debug('记忆抽取返回的 JSON 无法解析，已丢弃');
      return [];
    }
    if (!Array.isArray(parsed)) return [];

    const result: CapturedMemory[] = [];
    for (const item of parsed.slice(0, MAX_CAPTURE_PER_TURN)) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;

      const summaryRaw = typeof row.summary === 'string' ? row.summary : '';
      const contentRaw = typeof row.content === 'string' ? row.content : '';
      const summary = truncateSummary(summaryRaw);
      const content = contentRaw.trim();

      if (!summary || !content) continue;
      if (summary.length > SUMMARY_MAX_LENGTH) continue;
      // 敏感信息整条丢弃
      if (containsSensitiveInfo(summary) || containsSensitiveInfo(content)) {
        this.logger.debug('记忆候选命中敏感信息，已丢弃');
        continue;
      }

      const category = isMemoryCategory(row.category) ? row.category : 'OTHER';
      const importanceRaw =
        typeof row.importance === 'number' ? row.importance : 0.5;
      const importance = Number.isFinite(importanceRaw)
        ? Math.min(1, Math.max(0, importanceRaw))
        : 0.5;

      result.push({ category, summary, content, importance });
    }
    return result;
  }
}

/** 从可能带 markdown 包裹的文本里取出 JSON 数组字面量 */
function extractJsonArray(text: string): string | null {
  if (!text) return null;
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}
