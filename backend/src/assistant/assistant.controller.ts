import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { JwtUser } from '../auth/strategies/jwt.strategy';
import { PlatformAssistantService } from './platform-assistant.service';
import { PlatformToolsService } from '../platform-tools/platform-tools.service';
import { PlatformOperationLogService } from '../platform-tools/platform-operation-log.service';
import { UIActionBridgeService } from '../platform-tools/ui-action-bridge.service';
import type { UIContextPayload } from '../platform-tools/ui-action.types';
import { PersonaService } from '../persona/persona.service';

/**
 * 平台助理对外接口。
 *
 *   GET /platform/assistant            — 平台助理基本信息 + 人格 + 能力清单
 *   GET /platform/operations           — 当前用户的操作记录（审计）
 *   GET /platform/operations/stats     — 操作统计
 *
 * 说明：审计记录一律按 `userId = 当前登录用户` 过滤，
 * 不提供「查别人操作记录」的能力（管理员能力暂不在此范围内）。
 */
@Controller('platform')
@UseGuards(JwtAuthGuard)
export class AssistantController {
  constructor(
    private readonly platformAssistant: PlatformAssistantService,
    private readonly platformTools: PlatformToolsService,
    private readonly operationLog: PlatformOperationLogService,
    private readonly persona: PersonaService,
    private readonly uiActionBridge: UIActionBridgeService,
  ) {}

  @Get('assistant')
  async getAssistant(@CurrentUser() user: JwtUser) {
    const agent = await this.platformAssistant.ensure(user.id);
    const context = await this.platformAssistant.buildContext(user.id);
    const persona = await this.persona.get(user.id, agent.id);

    return {
      id: agent.id,
      /**
       * Agent.name 保留「平台助理」作为系统标识（ensure() 每次启动会纠偏它）；
       * 界面展示走 displayName = 人格名，用户改人格名时界面跟着变。
       */
      name: agent.name,
      displayName: persona.name,
      persona: {
        name: persona.name,
        tags: persona.tags,
        avatar: persona.avatar,
        voiceEnabled: persona.voiceEnabled,
        voiceId: persona.voiceId,
        proactiveChatEnabled: persona.proactiveChatEnabled,
        proactiveChatFrequency: persona.proactiveChatFrequency,
        desktopPetEnabled: persona.desktopPetEnabled,
        screenPerceptionEnabled: persona.screenPerceptionEnabled,
        screenPerceptionInterval: persona.screenPerceptionInterval,
        personaVersion: persona.personaVersion,
      },
      description: agent.description,
      isPlatformAssistant: true,
      currentWorkspaceId: context.currentWorkspaceId ?? null,
      currentWorkspaceName: context.currentWorkspaceName ?? null,
      workspaces: context.workspaces,
      capabilities: this.platformTools.listCapabilities(),
    };
  }

  @Get('operations')
  async listOperations(
    @CurrentUser() user: JwtUser,
    @Query('sessionId') sessionId?: string,
    @Query('targetType') targetType?: string,
    @Query('targetId') targetId?: string,
    @Query('status') status?: string,
    @Query('tool') tool?: string,
    @Query('limit') limit?: string,
  ) {
    return this.operationLog.list(user.id, {
      sessionId,
      targetType,
      targetId,
      status,
      tool,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('operations/stats')
  async operationStats(@CurrentUser() user: JwtUser) {
    return this.operationLog.stats(user.id);
  }

  /**
   * 注册浏览器会话（一个标签页一个 sessionId，浏览器启动时调用一次）。
   *
   * 多标签页时每个 tab 各自注册、各自轮询；桌宠投递指令时按「最近活动」
   * 选一个目标会话，避免 Tab B 抢走本该给 Tab A 的指令。
   */
  @Post('ui-command/register')
  registerUISession(
    @CurrentUser() user: JwtUser,
    @Body() body: { sessionId?: string },
  ) {
    const sessionId = String(body?.sessionId || '').trim();
    if (!sessionId) return { registered: false };
    this.uiActionBridge.register(user.id, sessionId);
    return { registered: true };
  }

  /** 浏览器心跳（可选；poll 本身也会刷新在线状态） */
  @Post('ui-command/heartbeat')
  heartbeatUISession(
    @CurrentUser() user: JwtUser,
    @Body() body: { sessionId?: string },
  ) {
    const sessionId = String(body?.sessionId || '').trim();
    if (!sessionId) return { ok: false };
    this.uiActionBridge.heartbeat(user.id, sessionId);
    return { ok: true };
  }

  /** 当前用户所有浏览器会话（在线状态 / 所在页面 / 积压指令数） */
  @Get('ui-command/sessions')
  listUISessions(@CurrentUser() user: JwtUser) {
    return { sessions: this.uiActionBridge.listSessions(user.id) };
  }

  /**
   * 网页版长轮询取「界面操作指令」。
   *
   * 场景：用户在桌宠里说「帮我打开 Skill 页面」，桌宠动不了网页。
   * 后端把指令投递到该用户的某个浏览器会话，网页版这里取走后执行，
   * 再走 `ui-result` 回传。
   *
   * 没有指令时挂起（默认 20 秒，最多 25 秒）—— 让桌宠说完话之后网页能立刻动起来，
   * 又不用引入 WebSocket。
   *
   * 顺带上报页面上下文：桌宠那边没有页面信息，靠这个补上，
   * 模型才知道用户现在停在哪一页。
   */
  @Post('ui-command/poll')
  async pollUICommands(
    @CurrentUser() user: JwtUser,
    @Body()
    body: { timeout?: number; uiContext?: UIContextPayload; sessionId?: string },
  ) {
    const raw = Number(body?.timeout);
    const timeoutMs = Number.isFinite(raw)
      ? Math.min(Math.max(raw, 1_000), 25_000)
      : 20_000;
    // 老客户端没传 sessionId 时退回一个固定会话，保持兼容
    const sessionId = String(body?.sessionId || '').trim() || 'default';
    const commands = await this.uiActionBridge.poll(
      user.id,
      sessionId,
      timeoutMs,
      body?.uiContext,
    );
    return { commands };
  }

  /**
   * 取消一个进行中的界面任务。
   *
   * 用户在执行多步骤操作时喊停：清掉尚未执行的后续指令、
   * 立刻唤醒正在等待结果的 Agent（否则要干等到超时），
   * 并打任务级取消标记让 Agent 停止后续步骤。
   *
   * 注意：已经执行完成的页面操作不会回滚。
   */
  @Post('ui-command/cancel')
  cancelUITask(
    @CurrentUser() user: JwtUser,
    @Body() body: { taskId?: string },
  ) {
    const taskId = String(body?.taskId || '').trim();
    if (!taskId) return { cancelled: 0 };
    const cancelled = this.uiActionBridge.cancelTask(taskId, user.id);
    return { cancelled };
  }

  /**
   * 前端回传界面操作的执行结果。
   *
   * 与 SSE 的 `ui_action` 事件配对：后端发出指令后挂起等待，
   * 前端执行完（无论成功失败）都必须调用这里，否则等待会超时。
   *
   * 只允许回传「自己发起」的操作：userId 来自 JWT，桥内部会二次校验。
   */
  @Post('ui-result')
  async reportUIActionResult(
    @CurrentUser() user: JwtUser,
    @Body()
    body: {
      actionId: string;
      success: boolean;
      message?: string;
      currentRoute?: string;
      /** 执行后的页面 id（skills / mcp / …） */
      currentPage?: string;
      /** 真实页面状态快照（dialogVisible 等） */
      actualState?: Record<string, unknown>;
      /** 结构化错误码 / 错误信息 */
      errorCode?: string;
      errorMessage?: string;
      /** 是否因用户取消而终止 */
      cancelled?: boolean;
      data?: Record<string, unknown>;
    },
  ) {
    const resolved = this.uiActionBridge.resolve(body.actionId, user.id, {
      success: body.success === true,
      message: body.message || (body.success ? '已执行' : '执行失败'),
      currentRoute: body.currentRoute,
      currentPage: body.currentPage,
      actualState: body.actualState,
      errorCode: body.errorCode,
      errorMessage: body.errorMessage,
      cancelled: body.cancelled === true,
      data: body.data,
    });
    return { resolved };
  }
}
