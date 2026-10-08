import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  Put,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { JwtUser } from '../auth/strategies/jwt.strategy';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { UpdateWorkflowDto } from './dto/update-workflow.dto';
import { WorkflowsService } from './workflows.service';
import { WorkflowEngine } from './engine/workflow.engine';

// ===========================================================================
// Workflow 基础 CRUD + 入队运行 + Run 查询
// ===========================================================================

@Controller()
@UseGuards(JwtAuthGuard)
export class WorkflowsController {
  constructor(private readonly workflowsService: WorkflowsService) {}

  @Post('workspaces/:workspaceId/workflows')
  create(
    @CurrentUser() user: JwtUser,
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body() dto: CreateWorkflowDto,
  ) {
    return this.workflowsService.create(user.id, workspaceId, dto);
  }

  @Get('workspaces/:workspaceId/workflows')
  findAll(
    @CurrentUser() user: JwtUser,
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
  ) {
    return this.workflowsService.findAll(user.id, workspaceId);
  }

  @Get('workflows/:id')
  findOne(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.workflowsService.findOne(user.id, id);
  }

  @Put('workflows/:id')
  update(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkflowDto,
  ) {
    return this.workflowsService.update(user.id, id, dto);
  }

  /** 发布当前草稿版本 → 产生一个新的 WorkflowVersion 作为稳定调用对象 */
  @Post('workflows/:id/publish')
  publish(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.workflowsService.publish(user.id, id);
  }

  /** 归档工作流 → Agent 不再可调用（状态机：PUBLISHED → ARCHIVED） */
  @Post('workflows/:id/archive')
  archive(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.workflowsService.archive(user.id, id);
  }

  /** 把已归档工作流恢复为草稿（状态机：ARCHIVED → DRAFT） */
  @Post('workflows/:id/restore')
  restore(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.workflowsService.restore(user.id, id);
  }

  /** 入队运行工作流 → 立即返回 runId，后台 BullMQ 执行 */
  @Post('workflows/:id/run')
  enqueueRun(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { input?: unknown },
  ) {
    return this.workflowsService.enqueueRun(user.id, id, body.input);
  }

  /** 查询单次运行结果（前端轮询用） */
  @Get('workflow-runs/:runId')
  getRun(
    @CurrentUser() user: JwtUser,
    @Param('runId', ParseUUIDPipe) runId: string,
  ) {
    return this.workflowsService.getRun(user.id, runId);
  }

  /** 查询某工作流的运行历史 */
  @Get('workflows/:id/runs')
  listRuns(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.workflowsService.listRuns(user.id, id);
  }

  /** 查询某次运行的节点级执行记录（含耗时/状态/输入输出） */
  @Get('workflow-runs/:runId/nodes')
  listNodeRuns(
    @CurrentUser() user: JwtUser,
    @Param('runId', ParseUUIDPipe) runId: string,
  ) {
    return this.workflowsService.listNodeRuns(user.id, runId);
  }
}

// ===========================================================================
// 直接运行工作流（开发/调试用，接收 definition 对象，不经过 BullMQ）
// ===========================================================================

@Controller('workflow')
export class WorkflowController {
  constructor(private readonly engine: WorkflowEngine) {}

  /** 直接同步运行（开发测试） */
  @Post('run')
  async run(@Body() body: any) {
    return this.engine.run(body.workflow, body.input);
  }

  /** 直接流式运行（开发测试） */
  @Post('run/stream')
  async runStream(@Body() body: any, @Res() response: Response) {
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders();

    const send = (event: unknown) => {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      for await (const event of this.engine.runStream(
        body.workflow,
        body.input,
      )) {
        send(event);
      }
    } catch (error) {
      send({
        type: 'error',
        message: error instanceof Error ? error.message : '工作流运行失败',
      });
    } finally {
      response.end();
    }
  }
}
