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
import { CreateKnowledgeBaseDto } from './dto/create-knowledge-base.dto';
import { UpdateKnowledgeBaseDto } from './dto/update-knowledge-base.dto';
import { KnowledgeService } from './knowledge.service';

@Controller()
@UseGuards(JwtAuthGuard)
export class KnowledgeController {
  constructor(private readonly knowledgeService: KnowledgeService) {}

  // ===========================================================================
  // 知识库基础 CRUD（owner 权限模型）
  // ===========================================================================

  /** 创建知识库 */
  @Post('knowledge-bases')
  create(@CurrentUser() user: JwtUser, @Body() dto: CreateKnowledgeBaseDto) {
    return this.knowledgeService.create(user.id, dto);
  }

  /** 获取当前用户的全部知识库 */
  @Get('knowledge-bases')
  findAll(@CurrentUser() user: JwtUser) {
    return this.knowledgeService.findAll(user.id);
  }

  /** 获取单个知识库详情 */
  @Get('knowledge-bases/:id')
  findOne(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.knowledgeService.findOne(user.id, id);
  }

  /** 更新知识库 */
  @Put('knowledge-bases/:id')
  update(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateKnowledgeBaseDto,
  ) {
    return this.knowledgeService.update(user.id, id, dto);
  }

  /** 删除知识库 */
  @Delete('knowledge-bases/:id')
  remove(@CurrentUser() user: JwtUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.knowledgeService.remove(user.id, id);
  }

  // ===========================================================================
  // Workspace ↔ KnowledgeBase 关联
  // ===========================================================================

  /** 获取工作空间关联的知识库 */
  @Get('workspaces/:workspaceId/knowledge-bases')
  findByWorkspace(
    @CurrentUser() user: JwtUser,
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
  ) {
    return this.knowledgeService.findByWorkspace(user.id, workspaceId);
  }

  /** 关联知识库到工作空间 */
  @Post('workspaces/:workspaceId/knowledge-bases/:kbId')
  linkToWorkspace(
    @CurrentUser() user: JwtUser,
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('kbId', ParseUUIDPipe) kbId: string,
  ) {
    return this.knowledgeService.linkToWorkspace(user.id, workspaceId, kbId);
  }

  /** 从工作空间解绑知识库 */
  @Delete('workspaces/:workspaceId/knowledge-bases/:kbId')
  unlinkFromWorkspace(
    @CurrentUser() user: JwtUser,
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('kbId', ParseUUIDPipe) kbId: string,
  ) {
    return this.knowledgeService.unlinkFromWorkspace(
      user.id,
      workspaceId,
      kbId,
    );
  }
}
