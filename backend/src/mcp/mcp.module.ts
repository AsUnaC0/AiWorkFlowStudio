import { Module, OnModuleDestroy } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EncryptionService } from '../common/crypto/encryption.service';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { McpConnectionService } from './mcp-connection.service';
import { McpToolService } from './mcp-tool.service';
import { McpUrlGuardService } from './mcp-url-guard.service';

/**
 * MCP 模块（分层）：
 *
 *   McpController          → 前端请求入口（CRUD / 测试连接 / 工具刷新 / 工具调试调用）
 *   McpService             → 配置管理 + 业务流程编排 + 凭据加密
 *   McpConnectionService   → 连接建立、协议协商、会话生命周期与缓存
 *   McpToolService         → 工具发现、schema 转换、工具调用与结果规范化
 *   McpUrlGuardService     → 目标地址安全校验（SSRF / DNS 重绑定 / 重定向）
 *   transports/*           → 传输实现（Streamable HTTP / 旧版 HTTP + SSE）
 *
 * 依赖 EncryptionService（与 LLM 模型配置共用同一套 AES-256-GCM 加密）。
 */
@Module({
  imports: [PrismaModule],
  controllers: [McpController],
  providers: [
    McpService,
    McpConnectionService,
    McpToolService,
    McpUrlGuardService,
    EncryptionService,
  ],
  exports: [McpService, McpToolService, McpConnectionService],
})
export class McpModule implements OnModuleDestroy {
  constructor(private readonly connections: McpConnectionService) {}

  async onModuleDestroy() {
    // 应用关闭时释放所有 MCP 会话（Streamable HTTP 发 DELETE，SSE 断开长连接）
    await this.connections.closeAll();
  }
}
