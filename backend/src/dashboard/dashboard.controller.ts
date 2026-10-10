import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { JwtUser } from '../auth/strategies/jwt.strategy';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  /** 核心指标卡片 - 资源规模、运行量、成功率 */
  @Get('overview')
  async getOverview(@CurrentUser() user: JwtUser) {
    return this.dashboardService.getOverview(user.id);
  }

  /** 工作流执行趋势（按天分组） */
  @Get('workflows/trend')
  async getWorkflowTrend(
    @CurrentUser() user: JwtUser,
    @Query('days') days?: string,
  ) {
    const d = days ? parseInt(days, 10) : 7;
    return this.dashboardService.getWorkflowTrend(user.id, d);
  }

  /** 工作流运行状态分布（成功/失败/运行中/排队） */
  @Get('workflows/status')
  async getWorkflowStatus(
    @CurrentUser() user: JwtUser,
    @Query('days') days?: string,
  ) {
    const d = days ? parseInt(days, 10) : 7;
    return this.dashboardService.getWorkflowStatusDistribution(user.id, d);
  }

  /** 节点类型平均耗时排行 */
  @Get('nodes/performance')
  async getNodePerformance(
    @CurrentUser() user: JwtUser,
    @Query('limit') limit?: string,
  ) {
    const l = limit ? parseInt(limit, 10) : 10;
    return this.dashboardService.getNodePerformance(user.id, l);
  }

  /** 知识库文档处理状态 */
  @Get('knowledge-bases/status')
  async getKnowledgeStatus(@CurrentUser() user: JwtUser) {
    return this.dashboardService.getKnowledgeStatus(user.id);
  }

  /** 最近运行记录 & 文档处理活动 */
  @Get('recent-activities')
  async getRecentActivities(
    @CurrentUser() user: JwtUser,
    @Query('limit') limit?: string,
  ) {
    const l = limit ? parseInt(limit, 10) : 10;
    return this.dashboardService.getRecentActivities(user.id, l);
  }

  /** BullMQ 队列积压/状态概览（按用户工作空间过滤） */
  @Get('queues/overview')
  async getQueueOverview(@CurrentUser() user: JwtUser) {
    return this.dashboardService.getQueueOverview(user.id);
  }
}
