import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { JwtUser } from '../auth/strategies/jwt.strategy';
import { PlatformAssistantService } from './platform-assistant.service';
import { PlatformToolsService } from '../platform-tools/platform-tools.service';
import { PlatformOperationLogService } from '../platform-tools/platform-operation-log.service';
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
  ) {}

  @Get('assistant')
  async getAssistant(@CurrentUser() user: JwtUser) {
    const agent = await this.platformAssistant.ensure();
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
}
