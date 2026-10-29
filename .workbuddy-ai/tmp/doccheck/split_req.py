import io, os

SRC = r"C:/Users/meibus/Desktop/AI WorkFlow Studio/docs/需求/AI_WorkFlow_Studio_项目需求与技术方案_v1.5_MCP_Skill更新版.md"
OUT = r"C:/Users/meibus/Desktop/AI WorkFlow Studio/docs/需求/v1.5"

lines = io.open(SRC, encoding="utf-8").read().split("\n")

groups = [
    ("01-项目概述与技术栈.md", 1, 288, "第 1~3 章", "项目定位、目标、技术选型、系统总体架构"),
    ("02-核心概念-Workspace-Workflow-Node.md", 289, 471, "第 4 章", "Workspace / Workflow / Node 三个核心概念与示例"),
    ("03-工作流节点体系.md", 472, 827, "第 5 章", "8 类节点（基础 / AI / Prompt / RAG / 文件 / HTTP / Condition）的配置与执行"),
    ("04-工作流编辑器与数据结构.md", 828, 991, "第 6~7 章", "编辑器交互、definition JSON 结构、发布与可见性"),
    ("05-执行引擎-异步-流式.md", 992, 1164, "第 8~10 章", "引擎调度、节点 Handler 路由、BullMQ 异步执行、SSE 流式"),
    ("06-知识库与RAG.md", 1165, 1414, "第 11 章", "知识库 / 文档 / 解析 / 切块 / 向量 / 检索 / RAG 全链路"),
    ("07-Agent与结构化输出.md", 1415, 1625, "第 12~13 章", "Agent 能力边界、Skill 与 MCP 职责、报告/表格/图表输出契约"),
    ("08-用户系统与权限.md", 1626, 1796, "第 15~16 章", "用户、Workspace 成员、好友、邀请、RBAC 权限矩阵"),
    ("09-数据模型.md", 1797, 2022, "第 17 章", "数据库核心模型与节点运行元数据"),
    ("10-接口规范与安全.md", 2023, 2124, "第 18~19 章", "API 设计原则、鉴权、密钥、HTTP 节点与上传安全"),
    ("11-前端页面与工程目录.md", 2125, 2240, "第 20~22 章", "页面与菜单建议、前端目录、后端目录"),
    ("12-开发阶段与MVP.md", 2241, 2450, "第 23~24 章", "9 个开发阶段与 MVP 范围"),
    ("13-产品模型与用户流程.md", 2451, 2639, "第 25 章", "核心产品关系、三个核心概念、进入 Workspace 的流程"),
    ("14-开发约束与协作规则.md", 2640, 2805, "第 26~29 章", "开发约束、与 AI 助手协作规则、后续开发方式、最终目标"),
    ("15-平台助理.md", 2806, 2881, "第 30 章", "平台助理的定位、17 个工具、四条安全约束、审计与边界"),
]

os.makedirs(OUT, exist_ok=True)
names = [g[0] for g in groups]

for i, (fn, a, b, chapters, desc) in enumerate(groups):
    body = "\n".join(lines[a - 1:b]).rstrip() + "\n"
    prev = f"[{names[i-1]}](./{names[i-1]})" if i > 0 else "—"
    nxt = f"[{names[i+1]}](./{names[i+1]})" if i < len(groups) - 1 else "—"
    header = (
        f"> **分册说明**：本文是《AI WorkFlow Studio 项目需求与技术方案 v1.5（MCP / Skill 更新版）》的拆分分册之一，"
        f"覆盖原文档**{chapters}**（{desc}）。内容与原文一致，仅按模块拆开便于单独阅读。\n"
        f"> **分册索引**：[README](./README.md) ｜ 上一册：{prev} ｜ 下一册：{nxt}\n\n---\n\n"
    )
    io.open(os.path.join(OUT, fn), "w", encoding="utf-8", newline="\n").write(header + body)
    print(f"{fn}: lines {a}-{b} ({b-a+1})")

# 校验：所有分册正文行数之和 = 原文行数
total = sum(b - a + 1 for _, a, b, _, _ in groups)
print("覆盖行数:", total, "原文行数:", len(lines), "末尾空行:", 0 if lines[-1] else 1)
