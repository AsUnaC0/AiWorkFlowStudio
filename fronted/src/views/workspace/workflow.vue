<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { VueFlow } from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { Controls } from "@vue-flow/controls";
import CustomNode from "@/components/workflow/CustomNode.vue";
import PageHeader from "@/components/common/PageHeader.vue";
import { useWorkflow } from "@/composables/useWorkflow";
import {
  enqueueRun,
  getRun,
  runWorkflowStream,
  type WorkflowRun,
  type WorkflowStreamEvent,
} from "@/api/workflow";
import { getKnowledgeBases } from "@/api/knowledge";
import type { KnowledgeBase } from "@/types/knowledge";
import type { WorkflowDefinition } from "@/types/workflow";
import { MessagePlugin } from "tdesign-vue-next";

// 样式引入
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";

const route = useRoute();
const workflowId = (route.params.id as string) || "default";

const {
  nodes,
  edges,
  selectedNode,
  onNodeClick: _originalOnNodeClick,
  onPaneClick,
  onDrop,
  onDragOver,
  loading,
  saving,
  errorMessage,
  workflowName,
  saveWorkflow,
  getCurrentDefinition,
  availableVariables,
} = useWorkflow(workflowId);

/** 包装 onNodeClick：每次点击节点都重新打开属性 Drawer + 深拷贝最新数据 */
const onNodeClick = (e: { node: any }) => {
  _originalOnNodeClick(e);
  if (selectedNode.value) {
    tempNodeData.value = JSON.parse(JSON.stringify(selectedNode.value.data));
    propertyDrawerVisible.value = true;
  }
};

const runDialogVisible = ref(false);
const runInput = ref("");
const running = ref(false);
const runResult = ref<unknown>(null);
const runError = ref("");
const currentNodeStatus = ref("");
const chatMessages = ref<{ role: "user" | "assistant"; content: string }[]>([]);
const runResultText = computed(() =>
  runResult.value === null ? "" : JSON.stringify(runResult.value, null, 2),
);
const currentRun = ref<WorkflowRun | null>(null);
let pollTimer: number | null = null;
let pollCount = 0;
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_COUNT = 150; // 150 × 2s = 5 分钟上限

/** 停止轮询 */
const stopRunPolling = () => {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  pollCount = 0;
};

/** 轮询运行结果直到 COMPLETED / FAILED 或超时 */
const pollRunResult = async (runId: string) => {
  pollCount = 0;
  pollTimer = window.setInterval(async () => {
    pollCount++;

    // 超时保护：超过 5 分钟仍未结束 → 停止轮询并提示
    if (pollCount > POLL_MAX_COUNT) {
      stopRunPolling();
      running.value = false;
      runError.value = "运行超时（5分钟），请稍后查看运行历史或 Worker 日志";
      currentNodeStatus.value = "";
      MessagePlugin.warning(runError.value);
      return;
    }

    try {
      const run = await getRun(runId);
      currentRun.value = run;
      currentNodeStatus.value =
        run.status === "QUEUED"
          ? `任务排队中... (${pollCount}s)`
          : run.status === "RUNNING"
            ? `工作流运行中... (${pollCount}s)`
            : "";

      if (run.status === "COMPLETED" || run.status === "FAILED") {
        stopRunPolling();
        running.value = false;

        if (run.status === "COMPLETED") {
          runResult.value = run.output;
          currentNodeStatus.value = "工作流运行完成";
          MessagePlugin.success("工作流运行完成");
        } else {
          runError.value = run.errorMessage || "工作流运行失败";
          MessagePlugin.error(runError.value);
        }
      }
    } catch (err) {
      console.error("轮询运行结果失败", err);
      // 轮询失败继续等，不要直接报错
    }
  }, POLL_INTERVAL_MS);
};

// ---------- SSE 调试运行（保留给开发调试用） ----------
const nodeLabel = (
  event: Extract<WorkflowStreamEvent, { type: "node:start" }>,
) => event.label || event.nodeType;

/** BullMQ 异步运行（生产模式：入队 → 轮询 → 显示结果） */
const handleRunWorkflow = async () => {
  running.value = true;
  runError.value = "";
  runResult.value = null;
  currentRun.value = null;

  try {
    // 关键：BullMQ Worker 读 DB 的 currentVersion
    // 画布改动没保存就入队 → Worker 跑的是旧 definition
    // 所以异步运行前先 auto-save
    await saveWorkflow();

    const run = await enqueueRun(workflowId, runInput.value);
    currentRun.value = run;

    chatMessages.value.push({ role: "user", content: runInput.value });
    chatMessages.value.push({ role: "assistant", content: "任务已入队，正在后台执行..." });

    currentNodeStatus.value = "任务已入队，等待 Worker 执行...";

    // 启动轮询
    pollRunResult(run.id);
  } catch (error) {
    runError.value = "保存或入队失败，请检查后端服务";
    MessagePlugin.error(runError.value);
    console.error("Workflow enqueue failed", error);
    running.value = false;
  }
};

/** SSE 实时运行（开发调试用 —— 同步执行，流式反馈） */
const handleRunWorkflowStream = async () => {
  running.value = true;
  runError.value = "";

  try {
    const definition = getCurrentDefinition();
    const workflow: WorkflowDefinition = {
      nodes: definition.nodes.map((node) => ({
        ...node,
        type: String(node.data?.nodeType ?? node.type),
        config: { ...node.data },
      })),
      edges: definition.edges,
    };

    chatMessages.value.push({ role: "user", content: runInput.value });
    chatMessages.value.push({ role: "assistant", content: "" });

    await runWorkflowStream(
      {
        workflow,
        input: runInput.value,
      },
      (event) => {
        if (event.type === "node:start") {
          currentNodeStatus.value = `正在运行：${nodeLabel(event)}`;
          if (event.nodeType === "llm" && chatMessages.value.at(-1)?.content) {
            chatMessages.value.push({ role: "assistant", content: "" });
          }
        } else if (event.type === "token") {
          const assistantMessage = chatMessages.value.at(-1);
          if (assistantMessage?.role === "assistant") {
            assistantMessage.content += event.content;
          }
        } else if (event.type === "node:complete") {
          currentNodeStatus.value = `已完成：${event.nodeType}`;
        } else if (event.type === "complete") {
          runResult.value = { input: runInput.value, data: event.data };
          currentNodeStatus.value = "工作流运行完成";
        }
      },
    );
    MessagePlugin.success("工作流运行完成");
  } catch (error) {
    runError.value = "工作流运行失败，请检查节点配置和后端服务";
    MessagePlugin.error(runError.value);
    console.error("Workflow run failed", error);
  } finally {
    running.value = false;
  }
};
const propertyDrawerVisible = ref(false);
const tempNodeData = ref<Record<string, any> | null>(null);

/** 关闭属性 Drawer */
const closePropertyDrawer = () => {
  propertyDrawerVisible.value = false;
  tempNodeData.value = null;
};

/** 确认：把 tempNodeData 回写到 tempNodeData，然后保存工作流 */
const handlePropertyConfirm = async () => {
  if (!selectedNode.value || !tempNodeData.value) {
    closePropertyDrawer();
    return;
  }
  // 深拷贝回写（保持响应式引用不丢）
  Object.keys(selectedNode.value.data).forEach(
    (k) => delete selectedNode.value!.data[k],
  );
  Object.assign(selectedNode.value.data, tempNodeData.value);
  selectedNode.value.data = tempNodeData.value;

  // 保存到后端
  await saveWorkflow();
  closePropertyDrawer();
};

/** 取消：放弃编辑内容，直接关闭 Drawer */
const handlePropertyCancel = () => {
  closePropertyDrawer();
};

// 监听 selectedNode 变化 → 打开/关闭属性 Drawer
watch(
  () => selectedNode.value,
  (node, _old) => {
    if (node) {
      tempNodeData.value = JSON.parse(JSON.stringify(node.data));
      propertyDrawerVisible.value = true;
    } else {
      // onPaneClick 清空选中时 → 关闭 Drawer
      propertyDrawerVisible.value = false;
      tempNodeData.value = null;
    }
  },
);

/** 当前用户可用的知识库列表（RAG 节点用） */
const knowledgeBases = ref<KnowledgeBase[]>([]);
const knowledgeBasesLoading = ref(false);

const fetchKnowledgeBases = async () => {
  knowledgeBasesLoading.value = true;
  try {
    knowledgeBases.value = await getKnowledgeBases();
  } catch (e) {
    console.error("加载知识库列表失败", e);
  } finally {
    knowledgeBasesLoading.value = false;
  }
};

onMounted(fetchKnowledgeBases);

const openRunDialog = () => {
  stopRunPolling();
  runInput.value = "";
  runResult.value = null;
  runError.value = "";
  currentNodeStatus.value = "";
  chatMessages.value = [];
  currentRun.value = null;
  runDialogVisible.value = true;
};

onBeforeUnmount(() => {
  stopRunPolling();
});

// ---------- HTTP 节点辅助函数 ----------
const addHeader = () => {
  if (!selectedNode.value) return;
  if (!selectedNode.value.data._headers) {
    selectedNode.value.data._headers = [];
  }
  selectedNode.value.data._headers.push({ key: "", value: "" });
};
const removeHeader = (index: number) => {
  if (!selectedNode.value?.data._headers) return;
  selectedNode.value.data._headers.splice(index, 1);
};

const addQuery = () => {
  if (!selectedNode.value) return;
  if (!selectedNode.value.data._query) {
    selectedNode.value.data._query = [];
  }
  selectedNode.value.data._query.push({ key: "", value: "" });
};
const removeQuery = (index: number) => {
  if (!selectedNode.value?.data._query) return;
  selectedNode.value.data._query.splice(index, 1);
};

// ---------- Condition 节点辅助函数 ----------
const OPERATOR_OPTIONS = [
  { value: "eq", label: "等于 (==)" },
  { value: "neq", label: "不等于 (!=)" },
  { value: "gt", label: "大于 (>)" },
  { value: "gte", label: "大于等于 (>=)" },
  { value: "lt", label: "小于 (<)" },
  { value: "lte", label: "小于等于 (<=)" },
  { value: "contains", label: "包含" },
  { value: "not_contains", label: "不包含" },
  { value: "is_empty", label: "为空" },
  { value: "is_not_empty", label: "不为空" },
];

/** 运算符是否需要右值 */
const operatorNeedsRight = (op: string): boolean =>
  op !== "is_empty" && op !== "is_not_empty";

const addCondition = () => {
  if (!selectedNode.value) return;
  if (!selectedNode.value.data._conditions) {
    selectedNode.value.data._conditions = [];
  }
  selectedNode.value.data._conditions.push({
    id: `rule-${Date.now()}`,
    left: "",
    operator: "eq",
    right: "",
  });
};

const removeCondition = (index: number) => {
  if (!selectedNode.value?.data._conditions) return;
  selectedNode.value.data._conditions.splice(index, 1);
};

const availableNodes = [
  { type: "start", label: "Start" },
  { type: "input", label: "Input" },
  { type: "llm", label: "LLM" },
  { type: "prompt", label: "Prompt" },
  { type: "rag", label: "RAG" },
  { type: "http", label: "HTTP" },
  { type: "condition", label: "Condition" },
  { type: "output", label: "Output" },
];

// 设置拖拽数据
const onDragStart = (event: DragEvent, nodeType: string, label: string) => {
  if (event.dataTransfer) {
    event.dataTransfer.setData("application/vueflow", nodeType);
    event.dataTransfer.setData("application/vueflow-label", label);
    event.dataTransfer.effectAllowed = "move";
  }
};
</script>

<template>
  <div class="workflow-editor">
    <PageHeader :title="workflowName || '工作流编辑器'" back-path="/workspace">
      <!-- 状态提示 -->
      <span v-if="loading" class="header-status">正在加载工作流...</span>
      <span v-else-if="errorMessage" class="header-status error">{{ errorMessage }}</span>

      <!-- 保存按钮 -->
      <t-button variant="outline" :disabled="saving || loading" :loading="saving" @click="saveWorkflow">
        {{ saving ? "保存中..." : "保存工作流" }}
      </t-button>

      <!-- 运行按钮 -->
      <t-button theme="primary" :disabled="loading || running" :loading="running" @click="openRunDialog">
        运行
      </t-button>
    </PageHeader>

    <div class="editor-body">
      <!-- 左侧：节点选择面板 -->
      <aside class="panel node-panel">
        <div class="panel-header">节点</div>
        <div class="node-list">
          <div v-for="item in availableNodes" :key="item.type" class="drag-node-item" draggable="true"
            @dragstart="onDragStart($event, item.type, item.label)">
            <span class="node-title">{{ item.label }}</span>
          </div>
        </div>
      </aside>

      <!-- 中间：Workflow 画布 -->
      <main class="canvas-area" @drop="onDrop" @dragover="onDragOver">
        <VueFlow :nodes="nodes" :edges="edges" @node-click="onNodeClick" @pane-click="onPaneClick" fit-view-on-init>
          <!-- 注册自定义节点组件 -->
          <template #node-custom="nodeProps">
            <CustomNode v-bind="nodeProps" />
          </template>

          <!-- 画布背景与控制微调部件 -->
          <Background pattern-color="#aaa" :gap="16" />
          <Controls />
        </VueFlow>
      </main>

      <!-- 右侧：属性 Drawer（替代固定面板） -->
      <t-drawer :show-overlay="false" v-model:visible="propertyDrawerVisible" placement="right" mode="overlay"
        header="节点属性" :width="360" show-in-attached-element :confirm-btn="{ content: '保存配置', loading: saving }"
        :cancel-btn="{ content: '取消' }" :close-on-overlay-click="true" @confirm="handlePropertyConfirm"
        @cancel="handlePropertyCancel" @close="handlePropertyCancel">
        <div v-if="tempNodeData" class="property-form">
          <!-- Drawer 内标题栏：显示节点基础信息 -->
          <div class="drawer-node-info">
            <span class="drawer-node-label">{{ tempNodeData.label }}</span>
            <span class="drawer-node-type">[{{ tempNodeData.nodeType }}]</span>
          </div>

          <div class="form-item">
            <label class="form-label">Node ID</label>
            <input class="form-input" :value="selectedNode?.id ?? ''" disabled />
          </div>

          <div class="form-item">
            <label class="form-label">Node Type</label>
            <input class="form-input" :value="tempNodeData.nodeType" disabled />
          </div>

          <div class="form-item">
            <label class="form-label">Label</label>
            <input class="form-input" v-model="tempNodeData.label" />
          </div>

          <!-- LLM 节点配置 (支持 Model, Temperature, Prompt 配置) -->
          <template v-if="tempNodeData.nodeType === 'llm'">
            <div class="form-item">
              <label class="form-label">Model</label>
              <select class="form-select" v-model="tempNodeData.model">
                <option value="qwen2.5:7b">Ollama (qwen2.5:7b)</option>
              </select>
            </div>

            <div class="form-item">
              <label class="form-label">Temperature: {{ tempNodeData.temperature }}</label>
              <input type="range" min="0" max="1" step="0.1" class="form-range"
                v-model.number="tempNodeData.temperature" />
            </div>

            <div class="form-item">
              <label class="form-label">System Prompt</label>
              <textarea class="form-textarea" rows="6" placeholder="你是一个有用的助手..."
                v-model="tempNodeData.prompt"></textarea>
              <div class="form-hint" v-pre>支持变量引用，如 <code>{{input}}</code>、<code>{{http_1.body}}</code></div>
            </div>

            <div class="form-item">
              <label class="form-label">User Prompt（可选）</label>
              <textarea class="form-textarea" rows="4" placeholder="留空则自动使用上一个节点的输出。支持 {{变量}}"
                v-model="tempNodeData.userPrompt"></textarea>
              <div class="form-hint" v-pre>自定义用户消息模板，支持 {{ input }}、{{ http_1.body.field }} 等</div>
            </div>
          </template>

          <!-- Prompt 节点配置 (支持 Model, Temperature, Prompt 配置) -->
          <template v-if="tempNodeData.nodeType === 'prompt'">

            <div class="form-item">
              <label class="form-label">Prompt</label>
              <textarea class="form-textarea" rows="6" placeholder="请输入 Prompt 模板"
                v-model="tempNodeData.prompt"></textarea>
            </div>
          </template>

          <!-- RAG 节点配置 -->
          <template v-if="tempNodeData.nodeType === 'rag'">
            <div class="form-item">
              <label class="form-label">Query 模板（可选）</label>
              <input class="form-input" v-model="tempNodeData.queryTemplate" placeholder="留空则自动使用上一个节点的输出" />
              <div class="form-hint">
                检索 query 模板，支持变量引用。如 <code v-pre>{{input}}</code>、<code v-pre>{{http_1.body.query}}</code>
              </div>
            </div>

            <div class="form-item">
              <label class="form-label">知识库（可多选）</label>
              <t-select v-model="tempNodeData.knowledgeBaseIds" multiple
                :disabled="knowledgeBasesLoading || knowledgeBases.length === 0" placeholder="请选择知识库">
                <t-option v-for="kb in knowledgeBases" :key="kb.id" :value="kb.id">
                  {{ kb.name }}
                  <span v-if="kb.documentCount" style="color:#bbb;margin-left:4px">
                    ({{ kb.documentCount }}文档)
                  </span>
                </t-option>
              </t-select>
              <div v-if="knowledgeBases.length === 0 && !knowledgeBasesLoading" class="form-hint">
                暂无知识库，请先去知识库管理创建
              </div>
            </div>

            <div class="form-item">
              <label class="form-label">检索模式</label>
              <select class="form-select" v-model="tempNodeData.searchMode">
                <option value="hybrid">混合检索（Hybrid，推荐）</option>
                <option value="vector">仅向量检索</option>
                <option value="keyword">仅关键词检索</option>
              </select>
            </div>

            <div class="form-item">
              <label class="form-label">Top K：{{ tempNodeData.topK ?? 5 }}</label>
              <input type="range" min="1" max="20" step="1" class="form-range" v-model.number="tempNodeData.topK" />
            </div>

            <div class="form-item" v-if="tempNodeData.searchMode !== 'keyword'">
              <label class="form-label">距离阈值：{{ tempNodeData.threshold ?? 0.8 }}</label>
              <input type="range" min="0.1" max="1.5" step="0.05" class="form-range"
                v-model.number="tempNodeData.threshold" />
              <div class="form-hint">越小越严格（0.5~0.8 常用）</div>
            </div>

            <div class="form-item">
              <label class="form-label">Embedding 模型</label>
              <input class="form-input" v-model="tempNodeData.embeddingModel" placeholder="nomic-embed-text" />
            </div>
          </template>

          <!-- HTTP 节点配置 -->
          <template v-if="tempNodeData.nodeType === 'http'">
            <!-- 请求方法 -->
            <div class="form-item">
              <label class="form-label">请求方法</label>
              <select class="form-select" v-model="tempNodeData.method">
                <option value="GET">GET</option>
                <option value="POST">POST</option>
                <option value="PUT">PUT</option>
                <option value="PATCH">PATCH</option>
                <option value="DELETE">DELETE</option>
              </select>
            </div>

            <!-- URL -->
            <div class="form-item">
              <label class="form-label">URL <span class="required">*</span></label>
              <input class="form-input" v-model="tempNodeData.url"
                placeholder="https://api.example.com/users/{{input}}" />
              <div class="form-hint">支持变量引用，如 <code v-pre>{{input}}</code>、<code v-pre>{{previous}}</code>、<code
                  v-pre>{{nodeId.body.field}}</code></div>
            </div>

            <!-- Headers -->
            <div class="form-item">
              <label class="form-label">Headers</label>
              <div class="kv-list">
                <div v-for="(_, index) in (tempNodeData._headers ?? [])" :key="'h-' + index" class="kv-row">
                  <input class="kv-input key" v-model="tempNodeData._headers[index].key" placeholder="Key" />
                  <input class="kv-input value" v-model="tempNodeData._headers[index].value"
                    placeholder="Value（支持 {{变量}}）" />
                  <button class="kv-del" @click="removeHeader(Number(index))">✕</button>
                </div>
                <button class="kv-add" @click="addHeader">+ 添加 Header</button>
              </div>
            </div>

            <!-- Query 参数 -->
            <div class="form-item">
              <label class="form-label">Query 参数</label>
              <div class="kv-list">
                <div v-for="(_, index) in (tempNodeData._query ?? [])" :key="'q-' + index" class="kv-row">
                  <input class="kv-input key" v-model="tempNodeData._query[index].key" placeholder="Key" />
                  <input class="kv-input value" v-model="tempNodeData._query[index].value"
                    placeholder="Value（支持 {{变量}}）" />
                  <button class="kv-del" @click="removeQuery(Number(index))">✕</button>
                </div>
                <button class="kv-add" @click="addQuery">+ 添加参数</button>
              </div>
            </div>

            <!-- Body（仅 POST/PUT/PATCH 显示） -->
            <div class="form-item" v-if="['POST', 'PUT', 'PATCH'].includes(tempNodeData.method ?? 'GET')">
              <label class="form-label">Body</label>
              <select class="form-select body-type" v-model="tempNodeData.bodyType">
                <option value="json">JSON</option>
              </select>
              <textarea class="form-textarea body-editor" rows="6" placeholder='{"name": "{{input}}"}'
                v-model="tempNodeData.body"></textarea>
              <div class="form-hint" v-pre>默认 Content-Type: application/json。支持 {{ 变量 }} 引用。</div>
            </div>

            <!-- Timeout -->
            <div class="form-item">
              <label class="form-label">Timeout (ms)</label>
              <input class="form-input" type="number" min="1000" max="120000" step="1000"
                v-model.number="tempNodeData.timeout" />
              <div class="form-hint">默认 30000ms，范围 1000 ~ 120000 ms</div>
            </div>
          </template>

          <!-- Condition 节点配置 -->
          <template v-if="tempNodeData.nodeType === 'condition'">
            <div class="form-item">
              <label class="form-label">条件关系</label>
              <div class="condition-logical">
                <label>
                  <input type="radio" value="AND" v-model="tempNodeData.logicalOperator" />
                  <span>AND（所有条件必须满足）</span>
                </label>
                <label>
                  <input type="radio" value="OR" v-model="tempNodeData.logicalOperator" />
                  <span>OR（任一条件满足即可）</span>
                </label>
              </div>
            </div>

            <div class="form-item">
              <label class="form-label">条件规则</label>
              <div class="condition-list">
                <div v-for="(rule, index) in (tempNodeData._conditions ?? [])" :key="rule.id" class="condition-rule">
                  <div class="condition-rule-header">
                    <span class="rule-index">条件 {{ Number(index) + 1 }}</span>
                    <button v-if="(tempNodeData._conditions?.length ?? 0) > 1" class="kv-del"
                      @click="removeCondition(Number(index))">✕</button>
                  </div>

                  <!-- 左值：变量选择器（支持分组 + 搜索 + 自由输入嵌套路径） -->
                  <label class="condition-field-label">判断数据（来自工作流变量）</label>
                  <t-select v-model="rule.left" filterable allow-input placeholder="选择变量，如 {{http_1.body.score}}"
                    clearable class="var-select">
                    <template v-for="group in availableVariables" :key="group.label">
                      <t-select-option-group :label="group.label">
                        <t-select-option v-for="opt in group.options" :key="opt.value" :value="opt.value"
                          :label="opt.label" />
                      </t-select-option-group>
                    </template>
                  </t-select>

                  <!-- 运算符 -->
                  <select class="form-select" v-model="rule.operator">
                    <option v-for="op in OPERATOR_OPTIONS" :key="op.value" :value="op.value">{{ op.label }}</option>
                  </select>

                  <!-- 右值（is_empty / is_not_empty 时隐藏） -->
                  <template v-if="operatorNeedsRight(rule.operator)">
                    <label class="condition-field-label">比较值（可填字面量或选变量）</label>
                    <div class="right-value-row">
                      <input class="form-input right-value-input" v-model="rule.right"
                        placeholder="60 / VIP / {{input.minScore}}" />
                      <t-popup placement="bottom" trigger="click" :overlay-style="{ minWidth: '220px' }">
                        <t-button size="small" variant="outline" theme="default">变量 ▾</t-button>
                        <template #content>
                          <div class="var-popup">
                            <t-select filterable allow-input placeholder="选变量 → 自动填入右值" class="var-select"
                              @change="(v: string) => { if (v) rule.right = v; }">
                              <template v-for="group in availableVariables" :key="'r-' + group.label">
                                <t-select-option-group :label="group.label">
                                  <t-select-option v-for="opt in group.options" :key="opt.value" :value="opt.value"
                                    :label="opt.label" />
                                </t-select-option-group>
                              </template>
                            </t-select>
                          </div>
                        </template>
                      </t-popup>
                    </div>
                  </template>
                </div>

                <button class="kv-add" @click="addCondition">+ 添加条件</button>
              </div>
            </div>

            <div class="form-item">
              <label class="form-label">输出分支</label>
              <div class="branch-info">
                <div class="branch-chip true">
                  <span class="dot"></span>
                  TRUE → 满足条件时走此分支
                </div>
                <div class="branch-chip false">
                  <span class="dot"></span>
                  FALSE → 不满足条件时走此分支
                </div>
              </div>
              <div class="form-hint">在画布上从节点右侧的两个连接点分别连线</div>
            </div>
          </template>
        </div>
      </t-drawer>
    </div>

    <t-dialog v-model:visible="runDialogVisible" header="运行工作流" :close-on-overlay-click="false" width="560px">
      <div class="run-dialog-content">
        <label class="form-label" for="workflow-run-input">输入内容</label>

        <!-- 后台运行状态（BullMQ 异步） -->
        <div v-if="currentRun" class="run-meta">
          <span class="run-meta-item">
            Run ID: <code>{{ currentRun.id.slice(0, 8) }}...</code>
          </span>
          <span class="run-meta-item" :class="'status-' + currentRun.status.toLowerCase()">
            {{ currentRun.status }}
          </span>
        </div>

        <div v-if="currentNodeStatus" class="node-status">
          {{ currentNodeStatus }}
        </div>
        <div class="chat-messages">
          <div v-for="(message, index) in chatMessages" :key="`${message.role}-${index}`" class="chat-message"
            :class="message.role">
            <div class="chat-role">
              {{ message.role === "user" ? "你" : "工作流" }}
            </div>
            <div class="chat-bubble">{{ message.content }}</div>
          </div>
        </div>
        <t-textarea id="workflow-run-input" v-model="runInput" :disabled="running"
          :autosize="{ minRows: 5, maxRows: 10 }" placeholder="请输入本次运行传给工作流的内容" />

        <div v-if="runError" class="run-error">{{ runError }}</div>
        <div v-if="runResult !== null" class="run-result">
          <div class="form-label">运行结果</div>
          <pre>{{ runResultText }}</pre>
        </div>
      </div>

      <!-- 自定义 footer：两种运行模式 -->
      <template #footer>
        <div class="run-dialog-actions">
          <t-button variant="outline" @click="runDialogVisible = false" :disabled="running">取消</t-button>
          <t-button variant="outline" theme="default" :loading="running" :disabled="running"
            @click="handleRunWorkflowStream" title="直接在前端传 definition 运行，未保存的画布改动也能试跑">
            调试运行（SSE）
          </t-button>
          <t-button theme="primary" :loading="running" :disabled="running" @click="handleRunWorkflow">
            运行（异步）
          </t-button>
        </div>
      </template>
    </t-dialog>
  </div>
</template>

<style scoped>
.workflow-editor {
  display: flex;
  flex-direction: column;
  width: 100vw;
  height: 100vh;
  overflow: hidden;

  .header-status {
    max-width: 420px;
    overflow: hidden;
    color: var(--color-text-tertiary);
    font-size: var(--font-sm);
    text-overflow: ellipsis;
    white-space: nowrap;

    &.error {
      color: var(--color-error);
    }
  }

  .editor-body {
    display: flex;
    flex: 1;
    min-height: 0;
    /* t-drawer show-in-attached-element 依赖相对定位容器 */
    position: relative;
  }

  /* 面板公共样式 */
  .panel {
    width: 240px;
    height: 100%;
    background-color: var(--color-bg-white);
    border-right: 1px solid var(--color-border);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;

    .panel-header {
      height: var(--header-height);
      line-height: var(--header-height);
      padding: 0 var(--space-4);
      font-weight: 600;
      font-size: var(--font-md);
      border-bottom: 1px solid var(--color-border);
      color: var(--color-text);
    }
  }

  /* 左侧节点选择区 */
  .node-panel {
    .node-list {
      padding: var(--space-4);
      display: flex;
      flex-direction: column;
      gap: var(--space-3);

      .drag-node-item {
        padding: var(--space-3) var(--space-4);
        background-color: var(--color-bg-light);
        border: 1px dashed var(--color-border-dashed);
        border-radius: var(--radius-md);
        cursor: grab;
        font-size: var(--font-base);
        color: var(--color-text);
        transition: all 0.2s ease;

        &:hover {
          background-color: var(--primary-light);
          border-color: var(--primary);
          color: var(--primary);
        }

        &:active {
          cursor: grabbing;
        }
      }
    }
  }

  /* 中间画布区 */
  .canvas-area {
    flex: 1;
    min-width: 0;
    background-color: var(--color-bg-canvas);
    position: relative;
  }

  /* Drawer 内顶部节点信息条 */
  .drawer-node-info {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    background: var(--primary-light);
    border-radius: var(--radius-sm);
    margin-bottom: var(--space-3);

    .drawer-node-label {
      font-size: var(--font-sm);
      font-weight: 600;
      color: var(--primary);
    }

    .drawer-node-type {
      font-size: 11px;
      color: var(--color-text-tertiary);
      font-family: "Menlo", "Consolas", monospace;
    }
  }

  .property-form {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);

    .form-item {
      display: flex;
      flex-direction: column;
      gap: 6px;

      .form-label {
        font-size: 12px;
        font-weight: 500;
        color: var(--color-text-tertiary);
      }

      .form-input,
      .form-select,
      .form-textarea {
        padding: var(--space-2);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        font-size: var(--font-sm);
        outline: none;

        &:focus {
          border-color: var(--primary);
        }

        &:disabled {
          background-color: var(--color-bg-light);
          cursor: not-allowed;
        }
      }

      .form-range {
        cursor: pointer;
      }

      .form-hint {
        font-size: 11px;
        color: var(--color-text-tertiary);
        line-height: 1.4;
      }

      .required {
        color: var(--color-error);
      }

      /* HTTP 节点 KV 编辑器 */
      .kv-list {
        display: flex;
        flex-direction: column;
        gap: 6px;

        .kv-row {
          display: flex;
          gap: 4px;
          align-items: center;

          .kv-input {
            flex: 1;
            min-width: 0;
            padding: 4px 6px;
            border: 1px solid var(--color-border);
            border-radius: var(--radius-sm);
            font-size: 12px;
            outline: none;

            &:focus {
              border-color: var(--primary);
            }

            &.key {
              flex: 0 0 38%;
            }
          }

          .kv-del {
            padding: 2px 6px;
            border: none;
            background: transparent;
            color: var(--color-text-tertiary);
            cursor: pointer;
            font-size: 12px;
            border-radius: var(--radius-sm);

            &:hover {
              color: var(--color-error);
              background: rgba(220, 38, 38, 0.08);
            }
          }
        }

        .kv-add {
          padding: 4px 8px;
          border: 1px dashed var(--color-border);
          border-radius: var(--radius-sm);
          background: transparent;
          color: var(--color-text-tertiary);
          font-size: 12px;
          cursor: pointer;
          transition: all 0.15s;

          &:hover {
            border-color: var(--primary);
            color: var(--primary);
          }
        }
      }

      .body-type {
        margin-bottom: 4px;
      }

      .body-editor {
        font-family: "Menlo", "Consolas", "Monaco", monospace;
        font-size: 12px;
      }

      /* Condition 节点配置 */
      .condition-logical {
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: 12px;
        color: var(--color-text);

        label {
          display: flex;
          align-items: center;
          gap: 6px;
          cursor: pointer;
        }
      }

      .condition-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .condition-rule {
        padding: 10px;
        border: 1px dashed var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg-light);
        display: flex;
        flex-direction: column;
        gap: 6px;

        .condition-rule-header {
          display: flex;
          justify-content: space-between;
          align-items: center;

          .rule-index {
            font-size: 11px;
            font-weight: 600;
            color: var(--color-text-tertiary);
          }
        }

        .condition-field-label {
          font-size: 11px;
          font-weight: 500;
          color: var(--color-text-tertiary);
          margin-top: 2px;
        }

        .var-select {
          width: 100%;
        }

        .right-value-row {
          display: flex;
          gap: 6px;
          align-items: center;

          .right-value-input {
            flex: 1;
            min-width: 0;
          }
        }
      }

      .var-popup {
        padding: 6px;

        .var-select {
          width: 200px;
        }
      }

      .branch-info {
        display: flex;
        flex-direction: column;
        gap: 6px;

        .branch-chip {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 10px;
          border-radius: var(--radius-sm);
          font-size: 12px;
          font-weight: 500;

          .dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
          }

          &.true {
            color: var(--color-success);
            background: rgba(34, 197, 94, 0.08);
            border: 1px solid rgba(34, 197, 94, 0.25);

            .dot {
              background: var(--color-success);
            }
          }

          &.false {
            color: var(--color-warning);
            background: rgba(245, 158, 11, 0.08);
            border: 1px solid rgba(245, 158, 11, 0.25);

            .dot {
              background: var(--color-warning);
            }
          }
        }
      }
    }
  }
}

.run-dialog-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);

  .run-meta {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    padding: var(--space-2) var(--space-3);
    background: var(--color-bg-light);
    border-radius: var(--radius-sm);
    font-size: var(--font-sm);

    .run-meta-item {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: var(--color-text-tertiary);

      code {
        font-family: "Menlo", "Consolas", monospace;
        font-size: 11px;
        color: var(--color-text-secondary);
      }
    }

    .run-meta-item.status-queued {
      color: var(--color-warning);
    }

    .run-meta-item.status-running {
      color: var(--primary);
    }

    .run-meta-item.status-completed {
      color: var(--color-success);
    }

    .run-meta-item.status-failed {
      color: var(--color-error);
    }
  }

  .run-dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }

  .run-error {
    color: var(--color-error);
    font-size: var(--font-sm);
  }

  .node-status {
    padding: var(--space-2) var(--space-3);
    border-left: 3px solid var(--primary);
    background: #f0f5ff;
    color: var(--primary);
    font-size: var(--font-sm);
  }

  .chat-messages {
    display: flex;
    max-height: 280px;
    flex-direction: column;
    gap: var(--space-3);
    overflow: auto;
    padding: 4px 2px;

    .chat-message {
      display: flex;
      max-width: 88%;
      flex-direction: column;
      gap: 4px;

      &.user {
        align-self: flex-end;
        align-items: flex-end;
      }

      &.assistant {
        align-self: flex-start;
        align-items: flex-start;
      }

      .chat-role {
        color: var(--color-text-tertiary);
        font-size: 12px;
      }

      .chat-bubble {
        padding: var(--space-3) var(--space-3);
        border-radius: 8px;
        background: var(--color-bg-canvas);
        color: var(--color-text);
        font-size: var(--font-sm);
        line-height: 1.6;
        white-space: pre-wrap;
        word-break: break-word;
      }
    }

    .user .chat-bubble {
      background: var(--primary);
      color: var(--color-bg-white);
    }
  }

  .run-result {
    margin-top: var(--space-2);

    pre {
      max-height: 220px;
      margin: var(--space-2) 0 0;
      padding: var(--space-3);
      overflow: auto;
      border-radius: var(--radius-sm);
      background: var(--color-bg-light);
      color: var(--color-text);
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-word;
    }
  }
}
</style>
