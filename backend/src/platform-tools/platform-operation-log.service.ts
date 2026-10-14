import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  PlatformOperationStatus,
  PlatformToolAction,
  PlatformToolRisk,
} from './platform-tool.interface';

/** 写审计时传入的原始记录（registry 负责组装） */
export interface PlatformOperationRecord {
  userId: string;
  workspaceId?: string;
  sessionId?: string;
  agentId?: string;
  tool: string;
  action: PlatformToolAction;
  riskLevel: PlatformToolRisk;
  targetType?: string;
  targetId?: string;
  targetName?: string;
  status: PlatformOperationStatus;
  summary?: string;
  link?: string;
  params?: Record<string, unknown>;
  errorMessage?: string;
  durationMs?: number;
}

/** 入参落库前的脱敏 / 截断：单条记录不允许被超长 JSON 撑爆 */
const MAX_PARAM_CHARS = 4000;
const REDACTED_KEYS = [
  'apikey',
  'api_key',
  'token',
  'password',
  'secret',
  'credential',
  'credentials',
  'authorization',
];

function sanitizeParams(
  params: Record<string, unknown> | undefined,
): Prisma.InputJsonValue | undefined {
  if (!params) return undefined;

  const scrub = (value: unknown, depth: number): unknown => {
    if (depth > 4) return '[deep]';
    if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(
        value as Record<string, unknown>,
      )) {
        out[key] = REDACTED_KEYS.includes(key.toLowerCase())
          ? '***'
          : scrub(val, depth + 1);
      }
      return out;
    }
    if (typeof value === 'string' && value.length > 800) {
      return `${value.slice(0, 800)}…(truncated)`;
    }
    return value;
  };

  let scrubbed: unknown;
  try {
    scrubbed = scrub(params, 0);
  } catch {
    return undefined;
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(scrubbed);
  } catch {
    return undefined;
  }
  if (serialized.length > MAX_PARAM_CHARS) {
    return { _truncated: true, preview: serialized.slice(0, MAX_PARAM_CHARS) };
  }
  return scrubbed as Prisma.InputJsonValue;
}

/**
 * PlatformOperationLogService —— 平台助理操作审计。
 *
 * 定位：**独立的操作账本**，与 ChatMessage.trail 解耦。
 *   - trail 会作为上下文喂回模型，属于会话数据
 *   - 本表不参与对话，只按「用户 / 资源 / 工具 / 时间」维度检索，用于追溯与排查
 *
 * 写入失败不允许影响主流程（工具执行结果必须照常返回给模型），因此全部 try/catch。
 */
@Injectable()
export class PlatformOperationLogService {
  private readonly logger = new Logger(PlatformOperationLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** 记录一次平台操作。返回落库后的 id（失败返回 null，不抛错） */
  async record(entry: PlatformOperationRecord): Promise<string | null> {
    try {
      const created = await this.prisma.platformOperationLog.create({
        data: {
          userId: entry.userId,
          workspaceId: entry.workspaceId ?? null,
          sessionId: entry.sessionId ?? null,
          agentId: entry.agentId ?? null,
          tool: entry.tool,
          action: entry.action,
          riskLevel: entry.riskLevel,
          targetType: entry.targetType ?? null,
          targetId: entry.targetId ?? null,
          targetName: entry.targetName ?? null,
          status: entry.status,
          summary: entry.summary ?? null,
          link: entry.link ?? null,
          params: sanitizeParams(entry.params),
          errorMessage: entry.errorMessage ?? null,
          durationMs: entry.durationMs ?? null,
        },
        select: { id: true },
      });
      return created.id;
    } catch (err) {
      this.logger.warn(
        `平台操作审计写入失败 tool=${entry.tool}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /** 查询当前用户的操作记录（前端「操作记录」抽屉 / 排查用） */
  async list(
    userId: string,
    params: {
      sessionId?: string;
      targetType?: string;
      targetId?: string;
      status?: string;
      tool?: string;
      limit?: number;
    } = {},
  ) {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);

    return this.prisma.platformOperationLog.findMany({
      where: {
        userId,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(params.targetType ? { targetType: params.targetType } : {}),
        ...(params.targetId ? { targetId: params.targetId } : {}),
        ...(params.status ? { status: params.status } : {}),
        ...(params.tool ? { tool: params.tool } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /** 统计：某用户的操作次数（按状态分组），用于概览 */
  async stats(userId: string) {
    const grouped = await this.prisma.platformOperationLog.groupBy({
      by: ['status'],
      where: { userId },
      _count: { _all: true },
    });
    return grouped.map((g) => ({
      status: g.status,
      count: g._count._all,
    }));
  }
}
