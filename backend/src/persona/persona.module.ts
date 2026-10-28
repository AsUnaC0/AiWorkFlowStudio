import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PersonaController } from './persona.controller';
import { PersonaService } from './persona.service';

/**
 * PersonaModule —— 平台默认助理的人格配置。
 *
 * 依赖方向：本模块只依赖 PrismaModule，**不** import AssistantModule。
 * 判定「是不是平台助理」直接查 Agent.isSystem / isDefault，避免
 * AssistantModule ↔ PersonaModule 循环依赖。
 *
 * 消费方：AssistantModule（Prompt 装配）、AgentModule（runStream 取人格）。
 */
@Module({
  imports: [PrismaModule],
  controllers: [PersonaController],
  providers: [PersonaService],
  exports: [PersonaService],
})
export class PersonaModule {}
