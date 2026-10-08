import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { JwtUser } from '../auth/strategies/jwt.strategy';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import { WorkspacesService } from './workspaces.service';

@Controller('workspaces')
@UseGuards(JwtAuthGuard)
export class WorkspacesController {
  constructor(private readonly workspacesService: WorkspacesService) {}

  @Post()
  create(@CurrentUser() user: JwtUser, @Body() dto: CreateWorkspaceDto) {
    return this.workspacesService.create(user.id, dto);
  }

  @Get()
  findAll(@CurrentUser() user: JwtUser) {
    return this.workspacesService.findAll(user.id);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.workspacesService.findOne(user.id, id);
  }

  @Put(':id')
  update(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkspaceDto,
  ) {
    return this.workspacesService.update(user.id, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.workspacesService.remove(user.id, id);
  }

  // ========== 成员管理 ==========

  /** 列出 Workspace 成员 */
  @Get(':id/members')
  listMembers(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.workspacesService.listMembers(user.id, id);
  }

  /** 邀请好友加入 Workspace */
  @Post(':id/members')
  inviteMember(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { inviteeId: string },
  ) {
    return this.workspacesService.inviteMember(user.id, id, body.inviteeId);
  }

  /** 移除 Workspace 成员 */
  @Delete(':id/members/:userId')
  removeMember(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.workspacesService.removeMember(user.id, id, userId);
  }
}
