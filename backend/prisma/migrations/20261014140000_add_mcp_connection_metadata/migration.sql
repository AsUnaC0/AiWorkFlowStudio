-- MCP 连接元数据：协议协商结果 + 最后成功连接时间
-- 配套 20261014140000_add_mcp_connection_metadata
--
-- 说明：McpServer.credentials 自本次改造起改为 AES-256-GCM 加密存储
-- （格式 { v: 2, cipher: "<base64(iv):base64(tag):base64(data)>" }），
-- 历史明文数据仍可读（解密逻辑兼容旧格式），下次更新该配置时自动重新加密。
-- 由于凭据是 Json 字段、加密后结构变化，无需 DDL 变更。

ALTER TABLE "McpServer" ADD COLUMN "protocolVersion" TEXT;
ALTER TABLE "McpServer" ADD COLUMN "serverName" TEXT;
ALTER TABLE "McpServer" ADD COLUMN "serverVersion" TEXT;
ALTER TABLE "McpServer" ADD COLUMN "lastConnectedAt" TIMESTAMP(3);
