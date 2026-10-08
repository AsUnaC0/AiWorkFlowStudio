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
import { CreateSkillDto } from './dto/create-skill.dto';
import { UpdateSkillDto } from './dto/update-skill.dto';
import { SkillService } from './skill.service';

/**
 * Skill CRUD — 独立资源，owner 权限模型。
 * Skill 不绑定 Workspace，可被 Workflow LLM 节点或 Agent 选用。
 */
@Controller('skills')
@UseGuards(JwtAuthGuard)
export class SkillController {
  constructor(private readonly skillService: SkillService) {}

  /** 创建 Skill */
  @Post()
  create(@CurrentUser() user: JwtUser, @Body() dto: CreateSkillDto) {
    return this.skillService.create(user.id, dto);
  }

  /** 获取当前用户的全部 Skills */
  @Get()
  findAll(@CurrentUser() user: JwtUser) {
    return this.skillService.findAll(user.id);
  }

  /** 获取单个 Skill 详情 */
  @Get(':id')
  findOne(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.skillService.findOne(user.id, id);
  }

  /** 更新 Skill */
  @Put(':id')
  update(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSkillDto,
  ) {
    return this.skillService.update(user.id, id, dto);
  }

  /** 删除 Skill */
  @Delete(':id')
  remove(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.skillService.remove(user.id, id);
  }
}
