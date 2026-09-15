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

  // 当前选中的节点
  const selectedNode = ref<Node | null>(null);

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
        prompt: type === "llm" ? "" : undefined,
        temperature: 0.7,
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
      const definition = workflow.currentVersion?.definition;
      if (definition) {
        initialNodes.value = definition.nodes;
        initialEdges.value = definition.edges;
        setNodes(definition.nodes);
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
    saveWorkflow,
    getCurrentDefinition,
  };
}
