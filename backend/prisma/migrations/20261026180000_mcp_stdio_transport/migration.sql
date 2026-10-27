-- MCP Server 支持 stdio 传输（本地子进程）
--
-- 1. serverUrl 改为可空：STDIO 传输没有 URL，只有 command + args
-- 2. 新增 command / args：等价于 Claude Desktop 配置里的 command / args
-- 3. 新增 envCipher：stdio 进程的环境变量，可能含 API Key，按 credentials 同样的
--    { v: 2, cipher } 格式加密存储（明文列会泄露到数据库备份与慢查询日志）

ALTER TABLE "McpServer" ALTER COLUMN "serverUrl" DROP NOT NULL;

ALTER TABLE "McpServer" ADD COLUMN "command" TEXT;
ALTER TABLE "McpServer" ADD COLUMN "args" JSONB;
ALTER TABLE "McpServer" ADD COLUMN "envCipher" JSONB;
