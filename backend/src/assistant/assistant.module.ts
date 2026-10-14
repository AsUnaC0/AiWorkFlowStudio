import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PlatformToolsModule } from '../platform-tools/platform-tools.module';
import { AssistantController } from './assistant.controller';
import { PlatformAssistantService } from './platform-assistant.service';

/**
 * Assistant 模块 —— 平台助理。
 *
 * 定位：把默认聊天 Agent 从「普通聊天机器人」升级成「理解当前用户、
 * 了解平台资源、可执行平台操作的统一入口」。
 *
 * 关键设计：**不重写大模型调用引擎**。
 *   平台助理复用 AgentService.runStream() 的流式对话 + Tool Calling 能力，
 *   本模块只负责提供三样东西：
 *     1. 专属 System Prompt（身份 / 行为约束 / 动态上下文）
 *     2. 平台工具定义（来自 PlatformToolsModule）
 *     3. 工具执行入口（权限校验 + 审计）
 *
 * 依赖方向：AgentModule → AssistantModule → PlatformToolsModule（单向，无循环）。
 * 因此本模块不 import AgentModule。
 */
@Module({
  imports: [AuthModule, PlatformToolsModule],
  controllers: [AssistantController],
  providers: [PlatformAssistantService],
  exports: [PlatformAssistantService],
})
export class AssistantModule {}
