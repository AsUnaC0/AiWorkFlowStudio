-- 系统默认 Agent（平台助理）从「全局单例」改为「每用户一条」
--
-- 背景：原先 isSystem && isDefault 的记录全局只有一条，createdBy 为 NULL。
-- 任何用户修改模型配置 / 温度后都对所有用户生效，人格配置同理。
-- 改为每用户一条独立记录后，配置按 createdBy 天然隔离。
--
-- 本索引保证「一个用户最多一条系统默认 Agent」，同时让并发 ensure() 的
-- 重复创建直接落库失败（应用层捕获 P2002 后回读已存在的那条）。
--
-- createdBy IS NULL 的旧共享记录不受约束限制，由应用层
-- PlatformAssistantService.migrateLegacySharedAgent() 拆分并降级为模板。

CREATE UNIQUE INDEX "Agent_system_default_per_user_key"
ON "Agent" ("createdBy")
WHERE "isSystem" = true
  AND "isDefault" = true
  AND "createdBy" IS NOT NULL;
