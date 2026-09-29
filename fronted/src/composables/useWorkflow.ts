import { onMounted, ref } from "vue";
import { useVueFlow, type Node, type Edge } from "@vue-flow/core";
import { getWorkflow, updateWorkflow } from "@/api/workflow";
import type { WorkflowDefinition } from "@/types/workflow";
import { MessagePlugin } from "tdesign-vue-next";

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
    }

    if (nodeType === "prompt") {
      data.prompt ??= "";
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
        // RAG 节点默认配置
        knowledgeBaseIds: type === "rag" ? [] : undefined,
        searchMode: type === "rag" ? "hybrid" : undefined,
        topK: type === "rag" ? 5 : undefined,
        threshold: type === "rag" ? 0.8 : undefined,
        embeddingModel: type === "rag" ? "nomic-embed-text" : undefined,
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
      const definition = {
        nodes: getNodes.value,
        edges: getEdges.value,
      } as unknown as WorkflowDefinition;
      await updateWorkflow(workflowId, { definition });
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

  const getCurrentDefinition = (): WorkflowDefinition => ({
    nodes: getNodes.value,
    edges: getEdges.value,
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
    saveWorkflow,
    getCurrentDefinition,
  };
}
