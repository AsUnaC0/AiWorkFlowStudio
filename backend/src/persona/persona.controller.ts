import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { JwtUser } from '../auth/strategies/jwt.strategy';
import { PersonaService } from './persona.service';
import { UpdatePersonaDto } from './dto/update-persona.dto';
import {
  PERSONA_LIMITS,
  PROACTIVE_FREQUENCY,
  VOICE_OPTIONS,
} from './persona.prompt';

/**
 * 人格配置接口（仅平台默认助理）。
 *
 *   GET  /agents/:id/persona          — 读取（未保存过则返回默认值）
 *   PUT  /agents/:id/persona          — 保存（personaVersion 自增）
 *   POST /agents/:id/persona/reset    — 恢复默认
 *   GET  /agents/:id/persona/options  — 音色白名单 / 频率档位（前端下拉用）
 *
 * 权限：PersonaService 内部校验 agentId 必须是 isSystem && isDefault，
 * 用户自建 Agent 一律 403 —— 不靠前端隐藏按钮来保证。
 */
@Controller('agents')
@UseGuards(JwtAuthGuard)
export class PersonaController {
  constructor(private readonly personaService: PersonaService) {}

  @Get(':id/persona')
  async getPersona(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.personaService.get(user.id, id);
  }

  @Put(':id/persona')
  async updatePersona(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: UpdatePersonaDto,
  ) {
    return this.personaService.upsert(user.id, id, dto);
  }

  @Post(':id/persona/reset')
  async resetPersona(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.personaService.reset(user.id, id);
  }

  /**
   * 可选值清单。
   *
   * 音色与频率档位是**服务端白名单**（需求 2.5 / 2.6），前端不该自己硬编码，
   * 否则后端调整白名单时前端会静默失配。
   */
  @Get(':id/persona/options')
  getOptions(@Param('id') id: string) {
    void id; // 路由上带 id 只是为了语义一致，白名单是全局的
    return {
      voices: VOICE_OPTIONS,
      frequencies: Object.entries(PROACTIVE_FREQUENCY).map(
        ([value, meta]) => ({
          value,
          label: meta.label,
          minPerHour: meta.min,
          maxPerHour: meta.max,
        }),
      ),
      limits: PERSONA_LIMITS,
    };
  }
}
