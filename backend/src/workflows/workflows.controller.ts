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
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { JwtUser } from '../auth/strategies/jwt.strategy';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { UpdateWorkflowDto } from './dto/update-workflow.dto';
import { WorkflowsService } from './workflows.service';
import { WorkflowEngine } from './engine/workflow.engine';
import type { Response } from 'express';

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
}

@Controller('workflow')
export class WorkflowController {
  constructor(private readonly engine: WorkflowEngine) {}

  @Post('run')
  async run(@Body() body: any) {
    return this.engine.run(body.workflow, body.input);
  }

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
