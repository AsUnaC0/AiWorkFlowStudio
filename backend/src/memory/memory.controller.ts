import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { JwtUser } from '../auth/strategies/jwt.strategy';
import { MemoryService } from './memory.service';
import { UpdateMemorySettingsDto } from './dto/update-memory-settings.dto';
import { MEMORY_CATEGORIES, MEMORY_CATEGORY_LABELS } from './memory.constant';

/**
 * 记忆接口。
 *
 *   GET    /memories                 — 列表（摘要 + 元信息，分页，不含原文）
 *   GET    /memories/graph           — 3D 图数据（节点 + 连线）
 *   GET    /memories/settings        — 生成 / 召回偏好
 *   PUT    /memories/settings        — 更新偏好
 *   GET    /memories/categories      — 分类枚举（前端过滤条）
 *   GET    /memories/:id             — 详情（含原文）
 *   DELETE /memories/:id             — 删除单条
 *   DELETE /memories                 — 清空全部
 *
 * 归属：userId 一律来自已验证 JWT，任何按 id 的查询都附带 userId 条件，
 * 因此「删别人的记忆」只会得到 404，不会泄露存在性。
 *
 * 路由顺序：静态路径（graph / settings / categories）必须声明在 `:id` 之前，
 * 否则会被 `:id` 抢先匹配。
 */
@Controller('memories')
@UseGuards(JwtAuthGuard)
export class MemoryController {
  constructor(private readonly memoryService: MemoryService) {}

  @Get()
  async list(
    @CurrentUser() user: JwtUser,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('category') category?: string,
  ) {
    return this.memoryService.list(user.id, {
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      category,
    });
  }

  @Get('graph')
  async graph(
    @CurrentUser() user: JwtUser,
    @Query('category') category?: string,
    @Query('limit') limit?: string,
  ) {
    return this.memoryService.graph(user.id, {
      category,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('settings')
  async getSettings(@CurrentUser() user: JwtUser) {
    return this.memoryService.getSettings(user.id);
  }

  @Put('settings')
  async updateSettings(
    @CurrentUser() user: JwtUser,
    @Body() dto: UpdateMemorySettingsDto,
  ) {
    return this.memoryService.updateSettings(user.id, dto);
  }

  @Get('categories')
  getCategories() {
    return MEMORY_CATEGORIES.map((category) => ({
      category,
      label: MEMORY_CATEGORY_LABELS[category],
    }));
  }

  @Get(':id')
  async detail(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.memoryService.detail(user.id, id);
  }

  @Delete(':id')
  async remove(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.memoryService.remove(user.id, id);
  }

  /** 清空全部（前端必须二次确认；后端只清当前用户的数据） */
  @Delete()
  async clear(@CurrentUser() user: JwtUser) {
    return this.memoryService.clearAll(user.id);
  }
}
