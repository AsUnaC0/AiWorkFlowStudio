import { Injectable } from '@nestjs/common';
import type {
  PlatformTool,
  PlatformToolContext,
  PlatformToolOutcome,
} from '../platform-tool.interface';
import type { UIActionInstruction } from '../ui-action.types';

/** 平台内可跳转的页面（与前端 page-catalog 的 pageId 一一对应） */
const PAGES = [
  'chat',
  'dashboard',
  'skills',
  'mcp',
  'agents',
  'knowledge',
  'workspace',
  'providers',
  'friends',
  'memory',
] as const;

/** 可打开的「新建」弹窗（与前端 DIALOG_ACTIONS 一一对应） */
const DIALOGS = [
  'create_skill',
  'create_mcp_server',
  'create_agent',
  'create_knowledge_base',
  'create_workspace',
  'create_workflow',
] as const;

const PAGE_LABELS: Record<(typeof PAGES)[number], string> = {
  chat: '对话',
  dashboard: '控制台',
  skills: 'Skill 管理',
  mcp: 'MCP Server 管理',
  agents: 'Agent 管理',
  knowledge: '知识库',
  workspace: '工作空间 / 工作流',
  providers: '模型管理',
  friends: '好友',
  memory: '记忆',
};

const DIALOG_LABELS: Record<(typeof DIALOGS)[number], string> = {
  create_skill: '新建 Skill',
  create_mcp_server: '新建 MCP Server',
  create_agent: '创建 Agent',
  create_knowledge_base: '创建知识库',
  create_workspace: '创建工作空间',
  create_workflow: '创建工作流',
};

/**
 * UI Control 工具 —— 让平台助理可以「带着用户操作界面」。
 *
 * 这些工具**不写任何业务数据**：
 *   - 跳转页面 → Vue Router
 *   - 打开弹窗 → 页面组件状态（Pinia / 组件 ref）
 *   - 填表     → 表单组件状态（不提交）
 *
 * 真正的业务写入仍然必须走 create_skill / create_workflow 等业务工具，
 * 绝不允许「前端模拟点击提交」绕过服务端校验。
 *
 * 所有工具都关闭审计（meta.audit=false）：界面操作不是业务操作，
 * 写进 PlatformOperationLog 只会污染「平台操作记录」。
 */
@Injectable()
export class UIControlTools {
  readonly tools: PlatformTool[] = [
    {
      name: 'ui_navigate',
      meta: {
        label: '页面跳转',
        action: 'EXECUTE',
        riskLevel: 'LOW',
        targetType: 'ui',
        audit: false,
      },
      definition: {
        type: 'function',
        function: {
          name: 'ui_navigate',
          description:
            '在平台内跳转到指定页面。只切换页面，不修改任何数据。' +
            '当用户说「打开 / 去 / 带我去 XX 页面」「怎么添加 Skill（想直接看页面）」时使用。' +
            '跳转后如需打开新建弹窗，再调用 ui_open_dialog。',
          parameters: {
            type: 'object',
            properties: {
              page: {
                type: 'string',
                enum: [...PAGES],
                description: '目标页面标识',
              },
            },
            required: ['page'],
          },
        },
      },
      execute: async (args) => this.navigate(args),
    },
    {
      name: 'ui_open_dialog',
      meta: {
        label: '打开弹窗',
        action: 'EXECUTE',
        riskLevel: 'LOW',
        targetType: 'ui',
        audit: false,
      },
      definition: {
        type: 'function',
        function: {
          name: 'ui_open_dialog',
          description:
            '打开指定页面上的「新建 / 创建」弹窗，让用户看到真实表单。' +
            '只打开界面，**不会创建任何数据**；真正创建请改用对应的业务工具' +
            '（create_skill / create_mcp_server / create_agent / create_knowledge_base 等）。' +
            '如果目标弹窗不在当前页面，会先自动跳转到所属页面。',
          parameters: {
            type: 'object',
            properties: {
              dialog: {
                type: 'string',
                enum: [...DIALOGS],
                description: '要打开的弹窗标识',
              },
            },
            required: ['dialog'],
          },
        },
      },
      execute: async (args) => this.openDialog(args),
    },
    {
      name: 'ui_click_action',
      meta: {
        label: '执行页面操作',
        action: 'EXECUTE',
        riskLevel: 'LOW',
        targetType: 'ui',
        audit: false,
      },
      definition: {
        type: 'function',
        function: {
          name: 'ui_click_action',
          description:
            '执行当前页面注册的语义化界面操作（可执行的操作名见「当前页面」上下文里的 availableActions）。' +
            '仅用于界面交互（如打开某个面板 / 详情），不修改业务数据。' +
            '拿不准操作名时，先调用 ui_get_page_context 查看当前页面可执行的操作。',
          parameters: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                description: '要执行的语义化操作名（必须是当前页面已注册的操作）',
              },
              params: {
                type: 'object',
                description: '操作参数（可选，键值对）',
              },
            },
            required: ['action'],
          },
        },
      },
      execute: async (args) => this.clickAction(args),
    },
    {
      name: 'ui_fill_form',
      meta: {
        label: '填写表单',
        action: 'EXECUTE',
        riskLevel: 'MEDIUM',
        targetType: 'ui',
        audit: false,
      },
      definition: {
        type: 'function',
        function: {
          name: 'ui_fill_form',
          description:
            '把用户提供的内容填入当前打开的创建表单（**只填不提交**）。' +
            '用于「帮我把名称和描述填好，我来点创建」这类协作场景。' +
            '需要真正创建数据时，仍然要用对应的业务工具，或让用户确认后提交。',
          parameters: {
            type: 'object',
            properties: {
              fields: {
                type: 'object',
                description: '要填写的字段键值对，如 { "name": "销售分析", "description": "…" }',
              },
            },
            required: ['fields'],
          },
        },
      },
      execute: async (args) => this.fillForm(args),
    },
    {
      name: 'ui_get_page_context',
      meta: {
        label: '查看当前页面',
        action: 'QUERY',
        riskLevel: 'LOW',
        targetType: 'ui',
        audit: false,
      },
      definition: {
        type: 'function',
        function: {
          name: 'ui_get_page_context',
          description:
            '查询用户当前所在的页面、页面用途、可执行的界面操作，以及是否有打开的弹窗。' +
            '在不确定「现在能做什么」时先调用它。',
          parameters: {
            type: 'object',
            properties: {},
          },
        },
      },
      execute: async (_args, ctx) => this.getPageContext(ctx),
    },
  ];

  private navigate(args: Record<string, unknown>): PlatformToolOutcome {
    const page = String(args.page ?? '').trim();
    if (!(PAGES as readonly string[]).includes(page)) {
      return {
        text: `错误：未知页面「${page}」。可用页面：${PAGES.join(' / ')}。`,
        status: 'FAILED',
        summary: '页面标识无效',
      };
    }

    const label = PAGE_LABELS[page as (typeof PAGES)[number]];
    return this.dispatch(
      { name: 'navigate', params: { page } },
      `跳转到「${label}」页面`,
    );
  }

  private openDialog(args: Record<string, unknown>): PlatformToolOutcome {
    const dialog = String(args.dialog ?? '').trim();
    if (!(DIALOGS as readonly string[]).includes(dialog)) {
      return {
        text: `错误：未知弹窗「${dialog}」。可用弹窗：${DIALOGS.join(' / ')}。`,
        status: 'FAILED',
        summary: '弹窗标识无效',
      };
    }

    const label = DIALOG_LABELS[dialog as (typeof DIALOGS)[number]];
    return this.dispatch(
      { name: 'open_dialog', params: { dialog } },
      `打开「${label}」弹窗`,
    );
  }

  private clickAction(args: Record<string, unknown>): PlatformToolOutcome {
    const action = String(args.action ?? '').trim();
    if (!action) {
      return {
        text: '错误：缺少 action 参数。',
        status: 'FAILED',
        summary: '缺少操作名',
      };
    }
    const extra =
      args.params && typeof args.params === 'object' && !Array.isArray(args.params)
        ? (args.params as Record<string, unknown>)
        : {};
    return this.dispatch(
      { name: 'click_action', params: { action, ...extra } },
      `执行页面操作「${action}」`,
    );
  }

  private fillForm(args: Record<string, unknown>): PlatformToolOutcome {
    const fields =
      args.fields && typeof args.fields === 'object' && !Array.isArray(args.fields)
        ? (args.fields as Record<string, unknown>)
        : null;
    if (!fields || Object.keys(fields).length === 0) {
      return {
        text: '错误：缺少 fields 参数（至少一个字段）。',
        status: 'FAILED',
        summary: '缺少表单字段',
      };
    }
    return this.dispatch(
      { name: 'fill_form', params: { fields } },
      `填写表单（${Object.keys(fields).join(' / ')}）`,
    );
  }

  private getPageContext(ctx: PlatformToolContext): PlatformToolOutcome {
    const ui = ctx.uiContext;
    if (!ui || (!ui.pageId && !ui.route)) {
      return {
        text:
          '前端未上报当前页面上下文（可能不在网页聊天页，或客户端不支持界面操作）。' +
          '此时不要假设用户正在某个页面；需要界面操作时先说明会帮用户跳转。',
        summary: '无页面上下文',
      };
    }

    const lines = [
      `当前页面：${ui.title ?? ui.pageId ?? '未知'}（${ui.route ?? '未知路由'}）`,
    ];
    if (ui.description) lines.push(`页面用途：${ui.description}`);
    if (ui.openDialog) lines.push(`当前打开的弹窗：${ui.openDialog}`);
    if (ui.availableActions?.length) {
      lines.push(
        '可执行的界面操作：',
        ...ui.availableActions.map(
          (a) => `- ${a.name}${a.label ? `（${a.label}）` : ''}${a.description ? `：${a.description}` : ''}`,
        ),
      );
    } else {
      lines.push('当前页面没有额外注册的界面操作。');
    }

    return {
      text: lines.join('\n'),
      summary: `当前页面：${ui.title ?? ui.pageId}`,
    };
  }

  /**
   * 统一的「派发」出口。
   *
   * 注意这里返回的 text 只是「已请求前端执行」的占位说明 ——
   * 当请求带 `uiControl=true` 时，AgentService 会挂起等待前端回传真实结果，
   * 并用真实结果覆盖这段文本；只有客户端不支持界面操作时才会用到这里的占位。
   */
  private dispatch(
    uiAction: UIActionInstruction,
    summary: string,
  ): PlatformToolOutcome {
    return {
      text: `已请求前端执行界面操作：${summary}。（执行结果由前端回传后确认）`,
      summary,
      targetType: 'ui',
      uiAction,
    };
  }
}
