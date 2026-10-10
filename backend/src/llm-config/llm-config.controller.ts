import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtUser } from '../auth/strategies/jwt.strategy';
import { LlmConfigService } from './llm-config.service';
import {
  CreateLlmConfigDto,
  TestLlmConfigDto,
  UpdateLlmConfigDto,
  UpdateLlmModelDto,
  type ModelCapability,
} from './llm-config.dto';

@Controller('llm-configs')
@UseGuards(JwtAuthGuard)
export class LlmConfigController {
  constructor(private readonly llmConfigService: LlmConfigService) {}

  /** GET /llm-configs —— 当前用户全部配置（API Key 已脱敏） */
  @Get()
  findAll(@CurrentUser() user: JwtUser) {
    return this.llmConfigService.findAll(user.id);
  }

  /** POST /llm-configs —— 新增配置（可选顺带添加首个模型） */
  @Post()
  create(@CurrentUser() user: JwtUser, @Body() dto: CreateLlmConfigDto) {
    return this.llmConfigService.create(user.id, dto);
  }

  /** POST /llm-configs/test —— 保存前预测试（不落库） */
  @Post('test')
  testBeforeSave(@Body() dto: TestLlmConfigDto) {
    return this.llmConfigService.testBeforeSave(dto);
  }

  /**
   * GET /llm-configs/models —— 当前用户全部启用模型（聊天/工作流/知识库选择器用）。
   * 可选 ?capability=CHAT|EMBEDDING 按能力过滤。
   */
  @Get('models')
  listModels(
    @CurrentUser() user: JwtUser,
    @Query('capability') capability?: ModelCapability,
  ) {
    return this.llmConfigService.listModels(user.id, capability);
  }

  /** PATCH /llm-configs/models/:id —— 更新模型（名称/能力/启用） */
  @Patch('models/:id')
  updateModel(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLlmModelDto,
  ) {
    return this.llmConfigService.updateModel(user.id, id, dto);
  }

  /** PATCH /llm-configs/models/:id/default —— 设为默认模型 */
  @Patch('models/:id/default')
  setDefaultModel(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.llmConfigService.setDefaultModel(user.id, id);
  }

  /** GET /llm-configs/:id —— 配置详情 */
  @Get(':id')
  findOne(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.llmConfigService.findOne(user.id, id);
  }

  /** PATCH /llm-configs/:id —— 更新配置 */
  @Patch(':id')
  update(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLlmConfigDto,
  ) {
    return this.llmConfigService.update(user.id, id, dto);
  }

  /** DELETE /llm-configs/:id —— 删除配置（级联删除模型） */
  @Delete(':id')
  remove(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.llmConfigService.remove(user.id, id);
  }

  /** POST /llm-configs/:id/test —— 对已保存配置测试连接 */
  @Post(':id/test')
  testSaved(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.llmConfigService.testSaved(user.id, id);
  }

  /** GET /llm-configs/:id/models —— 拉取模型列表并落地 */
  @Get(':id/models')
  fetchModels(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.llmConfigService.fetchModels(user.id, id);
  }
}
