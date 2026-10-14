/**
 * 工作流定义的「校验 + 摘要」工具。
 *
 * 为什么需要它：
 *   平台助理用自然语言生成工作流时，模型完全可能编造出不存在的 nodeType、
 *   漏掉必填配置、或者连出成环的边。**不能让模型生成的 JSON 直接落库**，
 *   必须先跑一遍这里定义的校验，把问题原样返回给模型让它修正。
 *
 * 这里使用的节点类型清单与 `workflows/engine/node-executor.registry.ts`
 * 注册的执行器保持一一对应 —— 引擎支持什么，助理才能生成什么。
 */

/** 引擎已注册的节点类型（= NodeExecutorRegistry 的 key 集合） */
export const WORKFLOW_NODE_TYPES = [
  'start',
  'input',
  'llm',
  'prompt',
  'rag',
  'http',
  'condition',
  'output',
] as const;

export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];

/** 节点类型 → 中文名（拼给模型看的提示 / 校验错误信息） */
export const WORKFLOW_NODE_LABELS: Record<string, string> = {
  start: 'Start 起点',
  input: 'Input 输入',
  llm: 'LLM 大模型',
  prompt: 'Prompt 提示词模板',
  rag: 'RAG 知识库检索',
  http: 'HTTP 请求',
  condition: 'Condition 条件分支',
  output: 'Output 输出',
};

/** 各节点类型的必填配置项（缺一不可） */
export const WORKFLOW_NODE_REQUIRED_CONFIG: Record<string, string[]> = {
  start: [],
  input: [],
  llm: [],
  prompt: ['prompt'],
  rag: ['knowledgeBaseIds'],
  http: ['url'],
  condition: ['conditions'],
  output: [],
};

export interface WorkflowDefinitionNode {
  id: string;
  type?: string;
  position?: { x: number; y: number };
  data?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

export interface WorkflowDefinitionEdge {
  id?: string;
  source: string;
  target: string;
}

export interface WorkflowDefinitionLike {
  nodes: WorkflowDefinitionNode[];
  edges: WorkflowDefinitionEdge[];
}

export interface WorkflowValidationOptions {
  /** 当前用户拥有的知识库 ID（用于校验 RAG 节点引用的知识库） */
  ownedKnowledgeBaseIds?: string[];
  /** 当前用户可用的自定义模型 ID（用于校验 LLM 节点引用的模型） */
  ownedLlmModelIds?: string[];
}

export interface WorkflowValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  summary: {
    nodeCount: number;
    edgeCount: number;
    nodes: Array<{ id: string; type: string; label: string }>;
    flow: string;
  };
}

/** 取节点的真实语义类型：优先 data.nodeType，回退 node.type（画布上 type 恒为 custom） */
export function resolveNodeType(node: WorkflowDefinitionNode): string {
  const fromData = node.data?.nodeType;
  if (typeof fromData === 'string' && fromData) return fromData;
  if (node.type && node.type !== 'custom') return node.type;
  return '';
}

/** 取节点配置：SSE 路径用 config，DB 路径配置在 data 里 */
export function resolveNodeConfig(
  node: WorkflowDefinitionNode,
): Record<string, unknown> {
  if (node.config && typeof node.config === 'object') return node.config;
  return node.data ?? {};
}

function isEmptyConfigValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/** 把 definition 里的节点 / 边整理成引擎可执行的规范形态（落库前统一格式） */
export function normalizeWorkflowDefinition(
  definition: WorkflowDefinitionLike,
): WorkflowDefinitionLike {
  const nodes = definition.nodes.map((node, index) => {
    const nodeType = resolveNodeType(node);
    const config = resolveNodeConfig(node);
    const label =
      typeof node.data?.label === 'string' && node.data.label
        ? node.data.label
        : (WORKFLOW_NODE_LABELS[nodeType] ?? nodeType);

    return {
      id: node.id,
      type: 'custom',
      position: node.position ?? { x: 250, y: 80 + index * 140 },
      data: {
        ...config,
        label,
        nodeType,
      },
    };
  });

  const edges = definition.edges.map((edge, index) => ({
    id: edge.id ?? `e-${edge.source}-${edge.target}-${index}`,
    source: edge.source,
    target: edge.target,
  }));

  return { nodes, edges };
}

/**
 * 校验工作流定义。返回结构化报告：
 *   - errors   → 必须修，否则不能保存
 *   - warnings → 能保存但大概率不符合预期
 */
export function validateWorkflowDefinition(
  definition: WorkflowDefinitionLike,
  options: WorkflowValidationOptions = {},
): WorkflowValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const nodes = Array.isArray(definition?.nodes) ? definition.nodes : [];
  const edges = Array.isArray(definition?.edges) ? definition.edges : [];

  if (nodes.length === 0) {
    errors.push('nodes 不能为空，工作流至少需要 Start 节点');
  }
  if (!Array.isArray(definition?.nodes)) {
    errors.push('definition.nodes 必须是数组');
  }
  if (!Array.isArray(definition?.edges)) {
    errors.push('definition.edges 必须是数组');
  }

  // ---- 节点级校验 ----
  const idSet = new Set<string>();
  const typeById = new Map<string, string>();
  const duplicateIds: string[] = [];

  for (const node of nodes) {
    const id = typeof node?.id === 'string' ? node.id : '';
    if (!id) {
      errors.push('存在缺少 id 的节点');
      continue;
    }
    if (idSet.has(id)) {
      duplicateIds.push(id);
      continue;
    }
    idSet.add(id);

    const nodeType = resolveNodeType(node);
    if (!nodeType) {
      errors.push(`节点「${id}」缺少 nodeType（应写在 data.nodeType）`);
      continue;
    }
    if (!WORKFLOW_NODE_TYPES.includes(nodeType as WorkflowNodeType)) {
      errors.push(
        `节点「${id}」使用了不支持的 nodeType「${nodeType}」。` +
          `平台当前支持：${WORKFLOW_NODE_TYPES.join(' / ')}`,
      );
      continue;
    }
    typeById.set(id, nodeType);

    const config = resolveNodeConfig(node);
    for (const field of WORKFLOW_NODE_REQUIRED_CONFIG[nodeType] ?? []) {
      if (isEmptyConfigValue(config[field])) {
        errors.push(
          `节点「${id}」（${WORKFLOW_NODE_LABELS[nodeType]}）缺少必填配置 ${field}`,
        );
      }
    }

    // RAG 节点：引用的知识库必须属于当前用户
    if (nodeType === 'rag' && options.ownedKnowledgeBaseIds) {
      const kbIds = Array.isArray(config.knowledgeBaseIds)
        ? (config.knowledgeBaseIds as unknown[]).filter(
            (v): v is string => typeof v === 'string',
          )
        : [];
      for (const kbId of kbIds) {
        if (!options.ownedKnowledgeBaseIds.includes(kbId)) {
          errors.push(
            `节点「${id}」引用了不可用的知识库 ${kbId}（不存在或无权访问）`,
          );
        }
      }
    }

    // LLM 节点：绑定的自定义模型必须属于当前用户
    if (nodeType === 'llm' && options.ownedLlmModelIds) {
      const llmModelId = config.llmModelId;
      if (
        typeof llmModelId === 'string' &&
        llmModelId &&
        !options.ownedLlmModelIds.includes(llmModelId)
      ) {
        errors.push(`节点「${id}」引用了不可用的模型配置 ${llmModelId}`);
      }
    }
  }

  if (duplicateIds.length > 0) {
    errors.push(`节点 id 重复：${[...new Set(duplicateIds)].join(', ')}`);
  }

  // ---- 结构校验 ----
  const startNodes = nodes.filter((n) => resolveNodeType(n) === 'start');
  if (startNodes.length === 0) {
    errors.push('缺少 start 节点，工作流必须有且仅有一个 Start 起点');
  } else if (startNodes.length > 1) {
    errors.push(`存在 ${startNodes.length} 个 start 节点，只允许一个`);
  }

  if (!nodes.some((n) => resolveNodeType(n) === 'output')) {
    warnings.push('没有 output 节点，运行结果不会被显式输出');
  }

  for (const edge of edges) {
    if (!idSet.has(edge?.source)) {
      errors.push(`连线引用了不存在的源节点「${edge?.source}」`);
    }
    if (!idSet.has(edge?.target)) {
      errors.push(`连线引用了不存在的目标节点「${edge?.target}」`);
    }
  }

  // ---- 可达性 + 环检测（从 start 出发做 DFS）----
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!idSet.has(edge?.source) || !idSet.has(edge?.target)) continue;
    const list = adjacency.get(edge.source) ?? [];
    list.push(edge.target);
    adjacency.set(edge.source, list);
  }

  const reachable = new Set<string>();
  const stack: string[] = [];
  if (startNodes.length > 0) stack.push(startNodes[0].id);
  let cycleDetected = false;
  const inPath = new Set<string>();

  const dfs = (nodeId: string) => {
    if (inPath.has(nodeId)) {
      cycleDetected = true;
      return;
    }
    if (reachable.has(nodeId)) return;
    reachable.add(nodeId);
    inPath.add(nodeId);
    for (const next of adjacency.get(nodeId) ?? []) {
      dfs(next);
    }
    inPath.delete(nodeId);
  };
  if (stack.length > 0) dfs(stack[0]);

  if (cycleDetected) {
    errors.push('工作流存在环（节点之间形成了循环依赖），引擎无法执行');
  }

  const unreachable = nodes
    .map((n) => n.id)
    .filter((id) => !reachable.has(id) && idSet.has(id));
  if (unreachable.length > 0 && startNodes.length > 0) {
    warnings.push(
      `以下节点从 Start 出发不可达，运行时不会被执行：${unreachable.join(', ')}`,
    );
  }

  // condition 节点：需要两条出边（true / false）
  for (const node of nodes) {
    if (resolveNodeType(node) !== 'condition') continue;
    const outCount = (adjacency.get(node.id) ?? []).length;
    if (outCount < 2) {
      warnings.push(
        `condition 节点「${node.id}」只有 ${outCount} 条出边，条件分支通常需要 true / false 两条`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    summary: summarizeWorkflowDefinition({ nodes, edges }),
  };
}

/** 生成人类可读的结构摘要（拼给模型 / 前端预览） */
export function summarizeWorkflowDefinition(
  definition: WorkflowDefinitionLike,
) {
  const nodes = Array.isArray(definition?.nodes) ? definition.nodes : [];
  const edges = Array.isArray(definition?.edges) ? definition.edges : [];

  const nodeList = nodes.map((n) => {
    const type = resolveNodeType(n) || 'unknown';
    const label =
      typeof n.data?.label === 'string' && n.data.label
        ? n.data.label
        : (WORKFLOW_NODE_LABELS[type] ?? type);
    return { id: n.id, type, label };
  });

  // 顺着边把执行路径串成 A → B → C（条件分支只取第一条，仅用于展示）
  const byId = new Map(nodeList.map((n) => [n.id, n]));
  const start = nodeList.find((n) => n.type === 'start');
  const chain: string[] = [];
  const visited = new Set<string>();
  let cursor = start?.id;
  while (cursor && !visited.has(cursor) && chain.length <= nodeList.length) {
    visited.add(cursor);
    const node = byId.get(cursor);
    chain.push(node ? `${node.label}` : cursor);
    const next = edges.find((e) => e.source === cursor);
    cursor = next?.target;
  }

  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes: nodeList,
    flow: chain.length > 0 ? chain.join(' → ') : '（未能解析出执行路径）',
  };
}

/** 工作流编辑器路由（前端 router 里 /workspace/:id 即编辑器） */
export function workflowEditorLink(workflowId: string): string {
  return `/workspace/${workflowId}`;
}

/** 知识库详情页路由 */
export function knowledgeBaseLink(kbId: string): string {
  return `/knowledge/${kbId}`;
}
