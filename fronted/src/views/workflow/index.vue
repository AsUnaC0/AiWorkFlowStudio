<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute } from "vue-router";
import { VueFlow } from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { Controls } from "@vue-flow/controls";
import CustomNode from "@/components/workflow/CustomNode.vue";
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
    <!-- 左侧：节点选择面板 -->
    <aside class="panel node-panel">
      <div class="panel-header">节点</div>
      <div class="node-list">
        <div
          v-for="item in availableNodes"
          :key="item.type"
          class="drag-node-item"
          draggable="true"
          @dragstart="onDragStart($event, item.type, item.label)"
        >
          <span class="node-title">{{ item.label }}</span>
        </div>
      </div>
    </aside>

    <!-- 中间：Workflow 画布 -->
    <main class="canvas-area" @drop="onDrop" @dragover="onDragOver">
      <div class="workflow-toolbar">
        <span v-if="loading" class="status-message">正在加载工作流...</span>
        <span v-else-if="errorMessage" class="status-message error">{{
          errorMessage
        }}</span>
        <button
          class="save-button"
          type="button"
          :disabled="saving || loading"
          @click="saveWorkflow"
        >
          {{ saving ? "保存中..." : "保存工作流" }}
        </button>

        <t-button
          class="save-button"
          :disabled="loading || running"
          :loading="running"
          @click="openRunDialog"
        >
          运行
        </t-button>
      </div>
      <VueFlow
        :nodes="nodes"
        :edges="edges"
        @node-click="onNodeClick"
        @pane-click="onPaneClick"
        fit-view-on-init
      >
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
          <input
            class="form-input"
            :value="selectedNode.data.nodeType"
            disabled
          />
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
            <label class="form-label"
              >Temperature: {{ selectedNode.data.temperature }}</label
            >
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              class="form-range"
              v-model.number="selectedNode.data.temperature"
            />
          </div>

          <div class="form-item">
            <label class="form-label">Prompt</label>
            <textarea
              class="form-textarea"
              rows="6"
              placeholder="请输入 Prompt 模板，支持变量如 {{input}}"
              v-model="selectedNode.data.prompt"
            ></textarea>
          </div>
        </template>
      </div>

      <!-- 未选中节点提示 -->
      <div v-else class="empty-tip">请在画布中选中节点以配置属性</div>
    </aside>

    <t-dialog
      v-model:visible="runDialogVisible"
      header="运行工作流"
      :confirm-btn="{ content: '运行', loading: running }"
      :cancel-btn="{ content: '取消' }"
      :close-on-overlay-click="false"
      @confirm="handleRunWorkflow"
    >
      <div class="run-dialog-content">
        <label class="form-label" for="workflow-run-input">输入内容</label>
        <div v-if="currentNodeStatus" class="node-status">
          {{ currentNodeStatus }}
        </div>
        <div class="chat-messages">
          <div
            v-for="(message, index) in chatMessages"
            :key="`${message.role}-${index}`"
            class="chat-message"
            :class="message.role"
          >
            <div class="chat-role">
              {{ message.role === "user" ? "你" : "工作流" }}
            </div>
            <div class="chat-bubble">{{ message.content }}</div>
          </div>
        </div>
        <t-textarea
          id="workflow-run-input"
          v-model="runInput"
          :disabled="running"
          :autosize="{ minRows: 5, maxRows: 10 }"
          placeholder="请输入本次运行传给工作流的内容"
        />

        <div v-if="runError" class="run-error">{{ runError }}</div>
        <div v-if="runResult !== null" class="run-result">
          <div class="form-label">运行结果</div>
          <pre>{{ runResultText }}</pre>
        </div>
      </div>
    </t-dialog>
  </div>
</template>

<style lang="less" scoped>
@border-color: #e5e6eb;
@bg-light: #f7f8fa;
@text-main: #1d1d1f;
@text-sub: #86909c;

.workflow-editor {
  display: flex;
  width: 100vw;
  height: 100vh;
  overflow: hidden;

  /* 面板公共样式 */
  .panel {
    width: 240px;
    height: 100%;
    background-color: #ffffff;
    border-right: 1px solid @border-color;
    display: flex;
    flex-direction: column;

    .panel-header {
      height: 48px;
      line-height: 48px;
      padding: 0 16px;
      font-weight: 600;
      font-size: 15px;
      border-bottom: 1px solid @border-color;
      color: @text-main;
    }
  }

  /* 左侧节点选择区 */
  .node-panel {
    .node-list {
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;

      .drag-node-item {
        padding: 10px 14px;
        background-color: @bg-light;
        border: 1px dashed darken(@border-color, 10%);
        border-radius: 6px;
        cursor: grab;
        font-size: 14px;
        color: @text-main;
        transition: all 0.2s ease;

        &:hover {
          background-color: #e8f3ff;
          border-color: #0052d9;
          color: #0052d9;
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
    height: 100%;
    background-color: #f2f3f5;
    position: relative;

    .workflow-toolbar {
      position: absolute;
      z-index: 5;
      top: 16px;
      right: 16px;
      left: 16px;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 12px;
      pointer-events: none;

      .status-message {
        max-width: 420px;
        overflow: hidden;
        color: @text-sub;
        font-size: 13px;
        text-overflow: ellipsis;
        white-space: nowrap;

        &.error {
          color: #d54941;
        }
      }

      .save-button {
        padding: 8px 16px;
        border: 0;
        border-radius: 4px;
        background: #0052d9;
        color: #ffffff;
        cursor: pointer;
        font-size: 13px;
        pointer-events: auto;

        &:disabled {
          cursor: not-allowed;
          opacity: 0.6;
        }
      }
    }
  }

  /* 右侧属性配置区 */
  .property-panel {
    border-right: none;
    border-left: 1px solid @border-color;
    width: 280px;

    .empty-tip {
      padding: 32px 16px;
      text-align: center;
      color: @text-sub;
      font-size: 13px;
    }

    .property-form {
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;

      .form-item {
        display: flex;
        flex-direction: column;
        gap: 6px;

        .form-label {
          font-size: 12px;
          font-weight: 500;
          color: @text-sub;
        }

        .form-input,
        .form-select,
        .form-textarea {
          padding: 8px;
          border: 1px solid @border-color;
          border-radius: 4px;
          font-size: 13px;
          outline: none;

          &:focus {
            border-color: #0052d9;
          }

          &:disabled {
            background-color: @bg-light;
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
    gap: 8px;

    .run-error {
      color: #d54941;
      font-size: 13px;
    }

    .node-status {
      padding: 8px 10px;
      border-left: 3px solid #0052d9;
      background: #f0f5ff;
      color: #0052d9;
      font-size: 13px;
    }

    .chat-messages {
      display: flex;
      max-height: 280px;
      flex-direction: column;
      gap: 12px;
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
          color: @text-sub;
          font-size: 12px;
        }

        .chat-bubble {
          padding: 10px 12px;
          border-radius: 8px;
          background: #f2f3f5;
          color: @text-main;
          font-size: 13px;
          line-height: 1.6;
          white-space: pre-wrap;
          word-break: break-word;
        }
      }

      .user .chat-bubble {
        background: #0052d9;
        color: #ffffff;
      }
    }

    .run-result {
      margin-top: 8px;

      pre {
        max-height: 220px;
        margin: 8px 0 0;
        padding: 12px;
        overflow: auto;
        border-radius: 4px;
        background: #f7f8fa;
        color: @text-main;
        font-size: 12px;
        white-space: pre-wrap;
        word-break: break-word;
      }
    }
  }
}
</style>
