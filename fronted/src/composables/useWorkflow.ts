import { computed, onMounted, ref } from "vue";
import { useVueFlow, type Node, type Edge } from "@vue-flow/core";
import { getWorkflow, updateWorkflow } from "@/api/workflow";
import type { WorkflowDefinition, WorkflowStatus } from "@/types/workflow";
import { MessagePlugin } from "tdesign-vue-next";

/** 节点类型 → 显示中文名 */
const NODE_TYPE_LABELS: Record<string, string> = {
  start: "Start",
  input: "Input",
  llm: "LLM",
  prompt: "Prompt",
  rag: "RAG",
  http: "HTTP",
  condition: "Condition",
  output: "Output",
};

/** 已知的节点输出字段（设计期可知的） */
interface OutputField {
  shortLabel: string; // 在 {{nodeId.xxx}} 里的 xxx
  fullTemplate: (nodeId: string) => string; // 完整模板
}

/**
 * 根据节点类型返回设计期已知的输出字段
 * HTTP body 内部字段（score/vip/...）运行时才知道，不列在这里
 */
function knownOutputFieldsFor(nodeType: string): OutputField[] {
  switch (nodeType) {
    case "start":
    case "input":
    case "llm":
    case "prompt":
    case "rag":
    case "output":
      return [
        {
          shortLabel: "output",
          fullTemplate: (id) => `{{${id}.output}}`,
        },
      ];

    case "http":
      return [
        {
          shortLabel: "status",
          fullTemplate: (id) => `{{${id}.status}}`,
        },
        {
          shortLabel: "headers",
          fullTemplate: (id) => `{{${id}.headers}}`,
        },
        {
          shortLabel: "body",
          fullTemplate: (id) => `{{${id}.body}}`,
        },
      ];

    case "condition":
      return [
        {
          shortLabel: "result",
          fullTemplate: (id) => `{{${id}.result}}`,
        },
        {
          shortLabel: "branch",
          fullTemplate: (id) => `{{${id}.branch}}`,
        },
      ];

    default:
      return [];
  }
}

export function useWorkflow(workflowId: string) {
  const {
    addNodes,
    onConnect,
    addEdges,
    project,
    getNodes,
    getEdges,
    setNodes,
    setEdges,
  } = useVueFlow();
  const loading = ref(false);
  const saving = ref(false);
  const errorMessage = ref("");
  const workflowName = ref("");

  // 工作流状态（用于编辑器顶部按钮区显示 [发布] [归档] 等）
  const workflowStatus = ref<WorkflowStatus>("DRAFT");
  const publishedVersion = ref<number | null>(null);
  const hasUnpublishedChanges = ref(false);

  // 当前选中的节点
  const selectedNode = ref<Node | null>(null);

  /**
   * 补齐节点缺失的默认配置字段
   * — 兼容旧版本保存的工作流（当时还没有这些字段）
   */
  const normalizeNodeData = (node: Node): Node => {
    const data = { ...(node.data ?? {}) };
    const nodeType: string = data.nodeType ?? node.type;

    if (nodeType === "rag") {
      data.knowledgeBaseIds ??= [];
      data.searchMode ??= "hybrid";
      data.topK ??= 5;
      data.threshold ??= 0.8;
      data.embeddingModel ??= "nomic-embed-text";
      // 旧数据可能残留 temperature（历史 bug：所有节点默认塞了 0.7），移除
      if ("temperature" in data && data.temperature === 0.7 && !data.model) {
        delete data.temperature;
      }
    }

    if (nodeType === "llm") {
      data.model ??= "qwen2.5:7b";
      data.temperature ??= 0.7;
      data.skillIds ??= [];
      data.mcpServerIds ??= [];
    }

    if (nodeType === "prompt") {
      data.prompt ??= "";
    }

    if (nodeType === "http") {
      data.method ??= "GET";
      data.url ??= "";
      data.bodyType ??= "json";
      data.timeout ??= 30000;
      // 编辑态用数组，持久化存 Record 格式。加载时把 Record 转回数组
      if (
        data.headers &&
        typeof data.headers === "object" &&
        !Array.isArray(data.headers)
      ) {
        data._headers = Object.entries(data.headers).map(([key, value]) => ({
          key,
          value: String(value),
        }));
        delete data.headers;
      }
      data._headers ??= [];
      if (
        data.query &&
        typeof data.query === "object" &&
        !Array.isArray(data.query)
      ) {
        data._query = Object.entries(data.query).map(([key, value]) => ({
          key,
          value: String(value),
        }));
        delete data.query;
      }
      data._query ??= [];
    }

    if (nodeType === "condition") {
      data.logicalOperator ??= "AND";
      // 加载持久化的 conditions → 编辑态 _conditions（带 id）
      if (
        Array.isArray(data.conditions) &&
        (!Array.isArray(data._conditions) || data._conditions.length === 0)
      ) {
        data._conditions = data.conditions.map((c: any, idx: number) => ({
          id: c.id ?? `rule-${idx + 1}`,
          left: c.left ?? "",
          operator: c.operator ?? "eq",
          right: c.right ?? "",
        }));
        delete data.conditions;
      }
      data._conditions ??= [
        { id: "rule-1", left: "", operator: "eq", right: "" },
      ];
    }

    return { ...node, data };
  };

  // 初始化节点示例 (匹配需求结构: Start -> LLM -> Output)
  const initialNodes = ref<Node[]>([
    {
      id: "start-1",
      type: "custom",
      position: { x: 250, y: 50 },
      data: { label: "Start", nodeType: "start" },
    },
    {
      id: "llm-1",
      type: "custom",
      position: { x: 250, y: 180 },
      data: {
        label: "LLM",
        nodeType: "llm",
        model: "qwen2.5:7b",
        prompt: "请分析以下内容：\n{{input}}",
        temperature: 0.7,
      },
    },
    {
      id: "output-1",
      type: "custom",
      position: { x: 250, y: 320 },
      data: { label: "Output", nodeType: "output" },
    },
  ]);

  // 初始化边连线
  const initialEdges = ref<Edge[]>([
    { id: "e-start-llm", source: "start-1", target: "llm-1" },
    { id: "e-llm-output", source: "llm-1", target: "output-1" },
  ]);

  // 处理节点间连线触发
  onConnect((connection) => {
    addEdges(connection);
  });

  // 处理节点点击选中
  const onNodeClick = (event: { node: Node }) => {
    // 选中时补齐缺失字段（兼容旧数据）
    const normalized = normalizeNodeData(event.node);
    if (normalized.data !== event.node.data) {
      // VueFlow 的 node data 是响应式代理，直接在原对象上补字段让 v-model 生效
      Object.assign(event.node.data, normalized.data);
    }
    selectedNode.value = event.node;
  };

  // 画布空白点击清空选中
  const onPaneClick = () => {
    selectedNode.value = null;
  };

  // 处理从左侧节点面板 Drag & Drop 到画布生成节点
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const type = event.dataTransfer?.getData("application/vueflow");
    const label = event.dataTransfer?.getData("application/vueflow-label");

    if (!type) return;

    // 获取画布中的坐标转换
    const position = project({
      x: event.clientX - 280, // 减去左侧面板宽度与偏移
      y: event.clientY - 60,
    });

    const newNode: Node = {
      id: `${type}-${Date.now()}`,
      type: "custom",
      position,
      data: {
        label: label || type.toUpperCase(),
        nodeType: type,
        model: type === "llm" ? "qwen2.5:7b" : undefined,
        prompt: type === "llm" || type === "prompt" ? "" : undefined,
        temperature: type === "llm" ? 0.7 : undefined,
        skillIds: type === "llm" ? [] : undefined,
        mcpServerIds: type === "llm" ? [] : undefined,
        // RAG 节点默认配置
        knowledgeBaseIds: type === "rag" ? [] : undefined,
        searchMode: type === "rag" ? "hybrid" : undefined,
        topK: type === "rag" ? 5 : undefined,
        threshold: type === "rag" ? 0.8 : undefined,
        embeddingModel: type === "rag" ? "nomic-embed-text" : undefined,
        // HTTP 节点默认配置
        method: type === "http" ? "GET" : undefined,
        url: type === "http" ? "" : undefined,
        bodyType: type === "http" ? "json" : undefined,
        timeout: type === "http" ? 30000 : undefined,
        _headers: type === "http" ? [] : undefined,
        _query: type === "http" ? [] : undefined,
        // Condition 节点默认配置
        logicalOperator: type === "condition" ? "AND" : undefined,
        _conditions:
          type === "condition"
            ? [{ id: "rule-1", left: "", operator: "eq", right: "" }]
            : undefined,
      },
    };

    addNodes([newNode]);
  };

  const onDragOver = (event: DragEvent) => {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
  };

  const loadWorkflow = async () => {
    if (!/^[0-9a-f-]{36}$/i.test(workflowId)) return;

    loading.value = true;
    errorMessage.value = "";
    try {
      const workflow = await getWorkflow(workflowId);
      workflowName.value = workflow.name || "";
      workflowStatus.value = workflow.status;
      publishedVersion.value = workflow.publishedVersion?.version ?? null;
      hasUnpublishedChanges.value =
        workflow.currentVersionId !== workflow.publishedVersionId;
      const definition = workflow.currentVersion?.definition;
      if (definition) {
        const normalizedNodes = definition.nodes.map((n: Node) =>
          normalizeNodeData(n),
        );
        initialNodes.value = normalizedNodes;
        initialEdges.value = definition.edges;
        setNodes(normalizedNodes);
        setEdges(definition.edges);
      }
    } catch {
      errorMessage.value = "工作流加载失败，请检查登录状态或工作流 ID";
    } finally {
      loading.value = false;
    }
  };

  const saveWorkflow = async () => {
    if (!/^[0-9a-f-]{36}$/i.test(workflowId)) {
      errorMessage.value = "当前页面没有有效的工作流 ID";
      return false;
    }

    saving.value = true;
    errorMessage.value = "";
    try {
      const definition = getCurrentDefinition();
      const updated = await updateWorkflow(workflowId, { definition });
      // 保存后会产生一个新的 currentVersionId → 与 publishedVersionId 不同
      workflowStatus.value = updated.status;
      publishedVersion.value = updated.publishedVersion?.version ?? null;
      hasUnpublishedChanges.value =
        updated.currentVersionId !== updated.publishedVersionId;
      MessagePlugin.success("工作流保存成功");
      return true;
    } catch {
      errorMessage.value = "工作流保存失败，请稍后重试";
      MessagePlugin.error("工作流保存失败，请稍后重试");
      return false;
    } finally {
      saving.value = false;
    }
  };

  /**
   * 由编辑器外部触发 publish/archive/restore 后调用：
   * 把返回的 workflow 对象状态同步到本地 ref
   */
  const syncStatusFromWorkflow = (wf: {
    status: WorkflowStatus;
    publishedVersion?: { version: number } | null;
    currentVersionId: string | null;
    publishedVersionId: string | null;
  }) => {
    workflowStatus.value = wf.status;
    publishedVersion.value = wf.publishedVersion?.version ?? null;
    hasUnpublishedChanges.value =
      wf.currentVersionId !== wf.publishedVersionId;
  };

  /** 把编辑态的节点数据转为持久化/运行时的干净格式 */
  const sanitizeNodeForSave = (node: Node): Node => {
    const data: any = { ...(node.data ?? {}) };
    const nodeType: string = data.nodeType ?? node.type;

    if (nodeType === "http") {
      // _headers 数组 → headers Record
      if (Array.isArray(data._headers)) {
        const headers: Record<string, string> = {};
        for (const row of data._headers) {
          if (row?.key?.trim()) headers[row.key.trim()] = row.value ?? "";
        }
        data.headers = headers;
        delete data._headers;
      }
      // _query 数组 → query Record
      if (Array.isArray(data._query)) {
        const query: Record<string, string> = {};
        for (const row of data._query) {
          if (row?.key?.trim()) query[row.key.trim()] = row.value ?? "";
        }
        data.query = query;
        delete data._query;
      }
    }

    if (nodeType === "condition") {
      // _conditions（编辑态）→ conditions（持久化）
      if (Array.isArray(data._conditions)) {
        data.conditions = data._conditions.map((c: any) => ({
          id: c.id ?? `rule-${Math.random().toString(36).slice(2, 8)}`,
          left: c.left ?? "",
          operator: c.operator ?? "eq",
          // right 可能是变量模板字符串或 JSON 字符串，直接透传
          right: c.right ?? "",
        }));
        delete data._conditions;
      }
      data.logicalOperator ??= "AND";
    }

    return { ...node, data };
  };

  const getCurrentDefinition = (): WorkflowDefinition => ({
    nodes: getNodes.value.map(sanitizeNodeForSave),
    edges: getEdges.value,
  });

  /**
   * 可用变量列表（扁平结构）
   * 自动从画布所有节点提取已知输出字段，供 Condition / HTTP / LLM 等节点选择
   */
  const availableVariables = computed(() => {
    const groups: Array<{
      label: string;
      options: Array<{ value: string; label: string }>;
    }> = [];

    // 1. 全局固定变量
    groups.push({
      label: "全局",
      options: [
        { value: "{{input}}", label: "input — 工作流初始输入" },
        { value: "{{previous}}", label: "previous — 上一个节点输出" },
      ],
    });

    // 2. 从画布所有节点提取
    const nodeGroups = new Map<
      string,
      Array<{ value: string; label: string }>
    >();

    for (const node of getNodes.value) {
      const nodeType: string =
        (node.data?.nodeType as string) ?? node.type ?? "";
      const nodeId = node.id;
      const nodeLabel: string =
        (node.data?.label as string) ?? nodeType ?? nodeId;

      const fields = knownOutputFieldsFor(nodeType);
      if (fields.length === 0) continue;

      const options = fields.map((field) => ({
        value: field.fullTemplate(nodeId),
        label: `${nodeId}${field.shortLabel !== "output" ? "." + field.shortLabel : ""}`,
      }));

      if (!nodeGroups.has(nodeType)) {
        nodeGroups.set(nodeType, []);
      }
      nodeGroups.get(nodeType)!.push(...options);

      // 也加一个节点整体输出（不带字段）
      nodeGroups.get(nodeType)!.push({
        value: `{{${nodeId}}}`,
        label: `${nodeId} — ${nodeLabel}（整体输出）`,
      });
    }

    // 按节点类型分组
    for (const [type, options] of nodeGroups) {
      groups.push({
        label: `${NODE_TYPE_LABELS[type] ?? type} 节点`,
        options,
      });
    }

    return groups;
  });

  onMounted(loadWorkflow);

  return {
    nodes: initialNodes,
    edges: initialEdges,
    selectedNode,
    onNodeClick,
    onPaneClick,
    onDrop,
    onDragOver,
    loading,
    saving,
    errorMessage,
    workflowName,
    workflowStatus,
    publishedVersion,
    hasUnpublishedChanges,
    saveWorkflow,
    getCurrentDefinition,
    availableVariables,
    syncStatusFromWorkflow,
  };
}
