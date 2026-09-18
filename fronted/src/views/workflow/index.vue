<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute } from "vue-router";
import { VueFlow } from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { Controls } from "@vue-flow/controls";
import CustomNode from "@/components/workflow/CustomNode.vue";
import PageHeader from "@/components/common/PageHeader.vue";
import { useWorkflow } from "@/composables/useWorkflow";
import { runWorkflowStream, type WorkflowStreamEvent } from "@/api/workflow";
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
} = useWorkflow(workflowId);

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

const openRunDialog = () => {
  runInput.value = "";
  runResult.value = null;
  runError.value = "";
  currentNodeStatus.value = "";
  chatMessages.value = [];
  runDialogVisible.value = true;
};

const nodeLabel = (
  event: Extract<WorkflowStreamEvent, { type: "node:start" }>,
) => event.label || event.nodeType;

const handleRunWorkflow = async () => {
  running.value = true;
  runError.value = "";

  try {
    const definition = getCurrentDefinition();
    const workflow: WorkflowDefinition = {
      nodes: definition.nodes.map((node) => ({
        ...node,
        type: String(node.data?.nodeType ?? node.type),
        data: node.data,
        config: {
          ...node.data,
          model:
            node.data?.model === "qwen2.5:7b" ? node.data.model : "qwen2.5:7b",
        },
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
    <PageHeader :title="workflowName || '工作流编辑器'" back-path="/workflow">
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

      <!-- 右侧：属性设置面板 -->
      <aside class="panel property-panel">
        <div class="panel-header">属性</div>

        <div v-if="selectedNode" class="property-form">
          <div class="form-item">
            <label class="form-label">Node ID</label>
            <input class="form-input" :value="selectedNode.id" disabled />
          </div>

          <div class="form-item">
            <label class="form-label">Node Type</label>
            <input class="form-input" :value="selectedNode.data.nodeType" disabled />
          </div>

          <div class="form-item">
            <label class="form-label">Label</label>
            <input class="form-input" v-model="selectedNode.data.label" />
          </div>

          <!-- LLM 节点配置 (支持 Model, Temperature, Prompt 配置) -->
          <template v-if="selectedNode.data.nodeType === 'llm'">
            <div class="form-item">
              <label class="form-label">Model</label>
              <select class="form-select" v-model="selectedNode.data.model">
                <option value="qwen2.5:7b">Ollama (qwen2.5:7b)</option>
              </select>
            </div>

            <div class="form-item">
              <label class="form-label">Temperature: {{ selectedNode.data.temperature }}</label>
              <input type="range" min="0" max="1" step="0.1" class="form-range"
                v-model.number="selectedNode.data.temperature" />
            </div>

            <div class="form-item">
              <label class="form-label">Prompt</label>
              <textarea class="form-textarea" rows="6" placeholder="请输入 Prompt 模板，支持变量如 {{input}}"
                v-model="selectedNode.data.prompt"></textarea>
            </div>
          </template>
        </div>

        <!-- 未选中节点提示 -->
        <div v-else class="empty-tip">请在画布中选中节点以配置属性</div>
      </aside>
    </div>

    <t-dialog v-model:visible="runDialogVisible" header="运行工作流" :confirm-btn="{ content: '运行', loading: running }"
      :cancel-btn="{ content: '取消' }" :close-on-overlay-click="false" @confirm="handleRunWorkflow">
      <div class="run-dialog-content">
        <label class="form-label" for="workflow-run-input">输入内容</label>
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

  /* 右侧属性配置区 */
  .property-panel {
    border-right: none;
    border-left: 1px solid var(--color-border);
    width: 280px;

    .empty-tip {
      padding: var(--space-8) var(--space-4);
      text-align: center;
      color: var(--color-text-tertiary);
      font-size: var(--font-sm);
    }

    .property-form {
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
      }
    }
  }

  .run-dialog-content {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);

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
}
</style>
