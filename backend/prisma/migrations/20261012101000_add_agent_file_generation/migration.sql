-- AlterTable: Agent 增加「允许生成文件」开关
-- 开启后 Agent 可使用 generate_file 工具产出 Word / Excel / PDF / Markdown / CSV 文件
ALTER TABLE "Agent" ADD COLUMN "enableFileGeneration" BOOLEAN NOT NULL DEFAULT true;
