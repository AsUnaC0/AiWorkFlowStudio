<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, nextTick } from "vue";
import { getModels, type AiModel } from "@/api/ai";
import {
  getAgentResources,
  runAgentStream,
  type AgentResourceWorkflow,
  type AgentResourceKnowledgeBase,
} from "@/api/agent";
import type { AgentStreamEvent } from "@/types/agent";
import { useClickOutside } from "@/composables/useClickOutside";
import { MessagePlugin } from "tdesign-vue-next";

// ===========================================================================
// 状态
// ===========================================================================

const models = ref<AiModel[]>([]);
const selectedModel = ref("");
const modelsLoading = ref(false);

const knowledgeOptions = ref<AgentResourceKnowledgeBase[]>([]);
const workflowOptions = ref<AgentResourceWorkflow[]>([]);
const resourcesLoading = ref(false);
const selectedKnowledgeIds = ref<string[]>([]);
const selectedWorkflowIds = ref<string[]>([]);

const inputText = ref("");
const sending = ref(false);
const inputRef = ref<HTMLTextAreaElement | null>(null);

// 聊天历史
interface TrailStep {
  type: "thinking" | "tool_call" | "tool_result";
  message: string;
  tool?: string;
  args?: Record<string, unknown>;
  result?: string;
  durationMs?: number;
}

interface ChatItem {
  role: "user" | "assistant";
  content: string;
  time: string;
  trail?: TrailStep[];
}
const messages = ref<ChatItem[]>([]);
const chatContainerRef = ref<HTMLElement | null>(null);

// 展开/折叠 trail
const expandedTrails = ref<Set<number>>(new Set());
const toggleTrail = (idx: number) => {
  if (expandedTrails.value.has(idx)) expandedTrails.value.delete(idx);
  else expandedTrails.value.add(idx);
};

const suggestions = [
  { icon: "flow", label: "Build a workflow", desc: "构建 AI 工作流" },
  { icon: "library", label: "Ask my knowledge base", desc: "查询知识库" },
  { icon: "chat-1", label: "Summarize a document", desc: "文档摘要" },
  { icon: "chart", label: "Analyze data", desc: "数据分析" },
];

// ===========================================================================
// 初始化
// ===========================================================================

const loadModels = async () => {
  modelsLoading.value = true;
  try {
    const res = await getModels();
    models.value = res.models;
    if (res.models.length > 0 && !selectedModel.value) {
      const chatModel = res.models.find(
        (m) => !m.name.includes("embed") && !m.name.includes("bge"),
      );
      selectedModel.value = chatModel?.name ?? res.models[0].name;
    }
  } catch {
    models.value = [
      { name: "qwen2.5:7b" },
      { name: "qwen2.5:3b" },
      { name: "deepseek-r1:7b" },
    ];
    selectedModel.value = "qwen2.5:7b";
  } finally {
    modelsLoading.value = false;
  }
};

// 一次性加载可用资源（已发布工作流 + 知识库）
const loadResources = async () => {
  resourcesLoading.value = true;
  try {
    const res = await getAgentResources();
    workflowOptions.value = res.workflows;
    knowledgeOptions.value = res.knowledgeBases;
  } catch {
    workflowOptions.value = [];
    knowledgeOptions.value = [];
  } finally {
    resourcesLoading.value = false;
  }
};

onMounted(() => {
  loadModels();
  loadResources();
});

onBeforeUnmount(() => {
  messages.value = [];
});

// ===========================================================================
// 聊天交互
// ===========================================================================

const canSend = computed(
  () => !sending.value && selectedModel.value.trim() && inputText.value.trim(),
);

const isEmpty = computed(() => messages.value.length === 0);

const scrollToBottom = async () => {
  await nextTick();
  if (chatContainerRef.value) {
    chatContainerRef.value.scrollTo({
      top: chatContainerRef.value.scrollHeight,
      behavior: "smooth",
    });
  }
};

// SSE 事件处理 —— 把 trail 事件聚合到最后一条 assistant 消息
let pendingAssistantIndex = -1;

const handleAgentEvent = (event: AgentStreamEvent) => {
  switch (event.type) {
    case "thinking": {
      if (pendingAssistantIndex === -1) {
        messages.value.push({
          role: "assistant",
          content: "",
          trail: [],
          time: new Date().toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
          }),
        });
        pendingAssistantIndex = messages.value.length - 1;
      }
      messages.value[pendingAssistantIndex].trail!.push({
        type: "thinking",
        message: event.message,
      });
      break;
    }

    case "tool_call": {
      if (pendingAssistantIndex === -1) {
        messages.value.push({
          role: "assistant",
          content: "",
          trail: [],
          time: new Date().toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
          }),
        });
        pendingAssistantIndex = messages.value.length - 1;
      }
      messages.value[pendingAssistantIndex].trail!.push({
        type: "tool_call",
        message: `调用工具 ${event.tool}`,
        tool: event.tool,
        args: event.args,
      });
      break;
    }

    case "tool_result": {
      const trail = messages.value[pendingAssistantIndex]?.trail;
      if (trail && trail.length > 0) {
        trail[trail.length - 1].result = event.result;
        trail[trail.length - 1].durationMs = event.durationMs;
      }
      break;
    }

    case "message": {
      if (pendingAssistantIndex >= 0) {
        messages.value[pendingAssistantIndex].content = event.content;
        pendingAssistantIndex = -1;
      } else {
        messages.value.push({
          role: "assistant",
          content: event.content,
          time: new Date().toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
          }),
        });
      }
      break;
    }

    case "error": {
      messages.value.push({
        role: "assistant",
        content: `⚠️ Agent 出错：${event.message}`,
        time: new Date().toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
        }),
      });
      pendingAssistantIndex = -1;
      break;
    }
  }
  scrollToBottom();
};

const send = async () => {
  if (!canSend.value) return;

  const userText = inputText.value.trim();
  inputText.value = "";
  messages.value.push({
    role: "user",
    content: userText,
    time: new Date().toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    }),
  });
  sending.value = true;
  pendingAssistantIndex = -1;
  scrollToBottom();

  try {
    const history = messages.value
      .slice(0, -1)
      .filter((m) => !m.trail || m.trail.length === 0)
      .map((m) => ({ role: m.role, content: m.content }));

    await runAgentStream(
      {
        input: userText,
        history,
        model: selectedModel.value,
        workflowIds: selectedWorkflowIds.value,
        knowledgeBaseIds: selectedKnowledgeIds.value,
      },
      handleAgentEvent,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Agent 请求失败";
    MessagePlugin.error(msg);
    messages.value.push({
      role: "assistant",
      content: `❌ 抱歉，请求失败：${msg}`,
      time: new Date().toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      }),
    });
  } finally {
    sending.value = false;
    scrollToBottom();
  }
};

const onKeydown = (e: KeyboardEvent) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
};

const useSuggestion = (text: string) => {
  inputText.value = text;
  inputRef.value?.focus();
};

const clearChat = () => {
  messages.value = [];
  pendingAssistantIndex = -1;
};

// 模型下拉控制
const showModelDropdown = ref(false);
const showKbDropdown = ref(false);
const showWfDropdown = ref(false);
const modelChipRef = ref<HTMLElement | null>(null);
const modelChipRefChat = ref<HTMLElement | null>(null);
const kbChipRef = ref<HTMLElement | null>(null);
const kbChipRefChat = ref<HTMLElement | null>(null);
const wfChipRef = ref<HTMLElement | null>(null);
const wfChipRefChat = ref<HTMLElement | null>(null);

useClickOutside([modelChipRef, modelChipRefChat], () => {
  showModelDropdown.value = false;
});
useClickOutside([kbChipRef, kbChipRefChat], () => {
  showKbDropdown.value = false;
});
useClickOutside([wfChipRef, wfChipRefChat], () => {
  showWfDropdown.value = false;
});

const toggleKnowledgeBase = (kbId: string) => {
  const idx = selectedKnowledgeIds.value.indexOf(kbId);
  if (idx > -1) selectedKnowledgeIds.value.splice(idx, 1);
  else selectedKnowledgeIds.value.push(kbId);
};

const toggleWorkflow = (wfId: string) => {
  const idx = selectedWorkflowIds.value.indexOf(wfId);
  if (idx > -1) selectedWorkflowIds.value.splice(idx, 1);
  else selectedWorkflowIds.value.push(wfId);
};

const hasKnowledgeSelected = computed(() => selectedKnowledgeIds.value.length > 0);
const hasWorkflowSelected = computed(() => selectedWorkflowIds.value.length > 0);

// Trail 格式化
const formatToolArgs = (args?: Record<string, unknown>) => {
  if (!args) return "";
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
};
const formatToolResult = (result?: string) => {
  if (!result) return "";
  if (result.length > 500) return result.slice(0, 500) + "...";
  return result;
};
</script>

<template>
  <div class="chat-page">
    <!-- 空状态：Hero 居中布局 -->
    <template v-if="isEmpty">
      <div class="hero-section">
        <div class="hero-content">
          <div class="hero-logo">✦</div>

          <h1 class="hero-title">How can I help you?</h1>
          <p class="hero-subtitle">
            选择工作流、知识库或直接提问，Agent 会自动判断调用什么工具。
          </p>

          <div class="prompt-box">
            <div class="prompt-textarea">
              <textarea ref="inputRef" v-model="inputText" placeholder="Ask anything..." :disabled="sending" rows="1"
                @keydown="onKeydown" />
              <button class="send-btn" :class="{ active: canSend }" :disabled="!canSend" @click="send">
                <t-icon :name="sending ? 'loading' : 'send'" :spin="sending" />
              </button>
            </div>

            <div class="prompt-actions">
              <!-- Model chip -->
              <div ref="modelChipRef" class="chip-wrapper">
                <button class="action-chip" @click="showModelDropdown = !showModelDropdown">
                  <t-icon name="server" />
                  <span>{{ selectedModel || 'Model' }}</span>
                  <t-icon name="caret-down-small" class="caret" />
                </button>
                <transition name="fast-fade">
                  <div v-if="showModelDropdown" class="chip-dropdown model">
                    <div class="dropdown-title">Select Model</div>
                    <div v-for="m in models" :key="m.name" class="dropdown-item"
                      :class="{ active: selectedModel === m.name }"
                      @click="selectedModel = m.name; showModelDropdown = false">
                      <span class="item-name">{{ m.name }}</span>
                      <t-icon v-if="selectedModel === m.name" name="check" />
                    </div>
                  </div>
                </transition>
              </div>

              <!-- Knowledge chip -->
              <div ref="kbChipRef" class="chip-wrapper">
                <button class="action-chip" @click="showKbDropdown = !showKbDropdown">
                  <t-icon name="library" />
                  <span>{{ hasKnowledgeSelected ? `${selectedKnowledgeIds.length} KB` : 'Knowledge' }}</span>
                  <t-icon name="caret-down-small" class="caret" />
                </button>
                <transition name="fast-fade">
                  <div v-if="showKbDropdown" class="chip-dropdown">
                    <div class="dropdown-title">Select Knowledge Bases</div>
                    <div v-for="kb in knowledgeOptions" :key="kb.id" class="dropdown-item"
                      :class="{ active: selectedKnowledgeIds.includes(kb.id) }" @click="toggleKnowledgeBase(kb.id)">
                      <span class="item-name">{{ kb.name }}</span>
                      <t-icon v-if="selectedKnowledgeIds.includes(kb.id)" name="check" />
                    </div>
                    <div v-if="knowledgeOptions.length === 0" class="dropdown-empty">暂无知识库</div>
                  </div>
                </transition>
              </div>

              <!-- ========== 新增：Workflow chip ========== -->
              <div ref="wfChipRef" class="chip-wrapper">
                <button class="action-chip" @click="showWfDropdown = !showWfDropdown">
                  <t-icon name="flow" />
                  <span>{{ hasWorkflowSelected ? `${selectedWorkflowIds.length} Workflow` : 'Workflow' }}</span>
                  <t-icon name="caret-down-small" class="caret" />
                </button>
                <transition name="fast-fade">
                  <div v-if="showWfDropdown" class="chip-dropdown">
                    <div class="dropdown-title">Select Published Workflows</div>
                    <div v-for="wf in workflowOptions" :key="wf.id" class="dropdown-item"
                      :class="{ active: selectedWorkflowIds.includes(wf.id) }" @click="toggleWorkflow(wf.id)">
                      <span class="item-name">{{ wf.name }} (v{{ wf.publishedVersion?.version ?? '-' }})</span>
                      <t-icon v-if="selectedWorkflowIds.includes(wf.id)" name="check" />
                    </div>
                    <div v-if="workflowOptions.length === 0" class="dropdown-empty">
                      暂无可绑定的已发布工作流
                    </div>
                  </div>
                </transition>
              </div>

              <div class="chip-divider" />

              <button v-if="hasKnowledgeSelected || hasWorkflowSelected" class="action-chip clear"
                @click="selectedKnowledgeIds = []; selectedWorkflowIds = []">
                <t-icon name="close" />
                <span>Clear</span>
              </button>
            </div>
          </div>

          <div class="suggestions">
            <button v-for="s in suggestions" :key="s.label" class="suggestion-card" @click="useSuggestion(s.label)">
              <div class="suggestion-icon">
                <t-icon :name="s.icon" />
              </div>
              <div class="suggestion-content">
                <div class="suggestion-label">{{ s.label }}</div>
                <div class="suggestion-desc">{{ s.desc }}</div>
              </div>
              <t-icon name="chevron-right" class="suggestion-arrow" />
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- 有对话后：标准聊天布局 -->
    <template v-else>
      <div class="chat-layout">
        <div ref="chatContainerRef" class="chat-messages">
          <div v-for="(msg, idx) in messages" :key="idx" class="message-item" :class="msg.role">
            <div class="message-avatar">
              <template v-if="msg.role === 'user'">👤</template>
              <template v-else>✦</template>
            </div>
            <div class="message-body">
              <div class="message-meta">
                <span class="message-role">{{ msg.role === 'user' ? 'You' : 'Agent' }}</span>
                <span class="message-time">{{ msg.time }}</span>
              </div>

              <!-- 执行轨迹 trail（只有 assistant 有） -->
              <div v-if="msg.trail && msg.trail.length > 0" class="trail">
                <div v-for="(step, sIdx) in msg.trail" :key="sIdx" class="trail-step" :class="step.type">
                  <template v-if="step.type === 'thinking'">
                    <span class="step-icon">💭</span>
                    <span class="step-text">{{ step.message }}</span>
                  </template>

                  <template v-else-if="step.type === 'tool_call'">
                    <span class="step-icon">🔧</span>
                    <button class="tool-toggle" @click="toggleTrail(idx)">
                      调用 <code>{{ step.tool }}</code>
                    </button>
                    <pre v-if="expandedTrails.has(idx)" class="tool-args">{{ formatToolArgs(step.args) }}</pre>
                  </template>

                  <template v-else-if="step.type === 'tool_result'">
                    <span class="step-icon">✅</span>
                    <span class="step-text" v-if="step.durationMs">返回结果（{{ step.durationMs }}ms）</span>
                    <button v-else class="tool-toggle" @click="toggleTrail(idx)">返回结果</button>
                    <pre v-if="expandedTrails.has(idx)" class="tool-result">{{ formatToolResult(step.result) }}</pre>
                  </template>
                </div>
              </div>

              <div class="message-content">{{ msg.content }}</div>

              <!-- typing 指示器：正在等待 SSE -->
              <div
                v-if="sending && idx === messages.length - 1 && msg.role === 'assistant' && !msg.content && (!msg.trail || msg.trail.length === 0)"
                class="typing">
                <span></span><span></span><span></span>
              </div>
            </div>
          </div>
        </div>

        <div class="chat-input-bottom">
          <div class="prompt-box compact">
            <div class="prompt-textarea">
              <textarea ref="inputRef" v-model="inputText" placeholder="Continue the conversation..."
                :disabled="sending" rows="1" @keydown="onKeydown" />
              <button class="send-btn" :class="{ active: canSend }" :disabled="!canSend" @click="send">
                <t-icon :name="sending ? 'loading' : 'send'" :spin="sending" />
              </button>
            </div>
            <div class="prompt-actions">
              <div ref="modelChipRefChat" class="chip-wrapper">
                <button class="action-chip tiny" @click="showModelDropdown = !showModelDropdown">
                  <t-icon name="server" />
                  <span>{{ selectedModel }}</span>
                </button>
                <transition name="fast-fade">
                  <div v-if="showModelDropdown" class="chip-dropdown model bottom-anchored">
                    <div v-for="m in models" :key="m.name" class="dropdown-item"
                      :class="{ active: selectedModel === m.name }"
                      @click="selectedModel = m.name; showModelDropdown = false">
                      {{ m.name }}
                      <t-icon v-if="selectedModel === m.name" name="check" />
                    </div>
                  </div>
                </transition>
              </div>

              <div ref="kbChipRefChat" class="chip-wrapper">
                <button class="action-chip tiny" @click="showKbDropdown = !showKbDropdown">
                  <t-icon name="library" />
                  <span v-if="hasKnowledgeSelected">{{ selectedKnowledgeIds.length }} KB</span>
                  <span v-else>Knowledge</span>
                </button>
                <transition name="fast-fade">
                  <div v-if="showKbDropdown" class="chip-dropdown bottom-anchored">
                    <div v-for="kb in knowledgeOptions" :key="kb.id" class="dropdown-item"
                      :class="{ active: selectedKnowledgeIds.includes(kb.id) }" @click="toggleKnowledgeBase(kb.id)">
                      {{ kb.name }}
                      <t-icon v-if="selectedKnowledgeIds.includes(kb.id)" name="check" />
                    </div>
                  </div>
                </transition>
              </div>

              <div ref="wfChipRefChat" class="chip-wrapper">
                <button class="action-chip tiny" @click="showWfDropdown = !showWfDropdown">
                  <t-icon name="flow" />
                  <span v-if="hasWorkflowSelected">{{ selectedWorkflowIds.length }} WF</span>
                  <span v-else>Workflow</span>
                </button>
                <transition name="fast-fade">
                  <div v-if="showWfDropdown" class="chip-dropdown bottom-anchored">
                    <div v-for="wf in workflowOptions" :key="wf.id" class="dropdown-item"
                      :class="{ active: selectedWorkflowIds.includes(wf.id) }" @click="toggleWorkflow(wf.id)">
                      {{ wf.name }} (v{{ wf.publishedVersion?.version ?? '-' }})
                      <t-icon v-if="selectedWorkflowIds.includes(wf.id)" name="check" />
                    </div>
                  </div>
                </transition>
              </div>

              <button v-if="messages.length > 0" class="action-chip tiny clear-all" @click="clearChat">
                <t-icon name="delete" />
                <span>New chat</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped lang="less">
@import "../../styles/variables.less";

.chat-page {
  height: 100%;
  width: 100%;
}

/* ========== Trail 样式（新增） ========== */
.trail {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: @space-2;
  margin-bottom: @space-1;
  width: 100%;

  .trail-step {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-radius: 6px;
    font-size: 12px;

    &.thinking {
      color: @color-text-tertiary;
      background: rgba(0, 0, 0, 0.03);
    }

    &.tool_call {
      background: @primary-light;
      color: @primary;
    }

    &.tool_result {
      background: rgba(34, 197, 94, 0.08);
      color: @color-success;
    }

    .step-icon {
      font-size: 14px;
      flex-shrink: 0;
    }

    .step-text {
      color: @color-text-tertiary;
    }

    code {
      font-family: "Menlo", "Consolas", monospace;
      background: rgba(0, 0, 0, 0.06);
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 11px;
    }

    .tool-toggle {
      background: transparent;
      border: none;
      color: inherit;
      cursor: pointer;
      font-size: 12px;
      padding: 2px 6px;
      border-radius: 4px;

      &:hover {
        background: rgba(0, 0, 0, 0.06);
      }
    }

    .tool-args,
    .tool-result {
      margin: 2px 0 0 20px;
      padding: 8px 10px;
      border-radius: 6px;
      background: rgba(0, 0, 0, 0.04);
      font-size: 11px;
      font-family: "Menlo", "Consolas", monospace;
      max-height: 250px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
      width: 100%;
    }
  }
}

/* ========== Hero (空状态) ========== */
.hero-section {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: @space-12 @space-8;
}

.hero-content {
  width: 100%;
  max-width: 720px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: @space-6;
  animation: fade-slide-up @duration-normal @ease-out;
}

.hero-logo {
  width: 48px;
  height: 48px;
  border-radius: @radius-xl;
  background: linear-gradient(135deg, @primary 0%, lighten(@primary, 8%) 100%);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  font-weight: 700;
  box-shadow: 0 4px 16px @primary-shadow;
  animation: fade-slide-up @duration-normal @ease-out 50ms both;
}

.hero-title {
  font-size: @font-hero;
  font-weight: 700;
  color: @color-text;
  letter-spacing: -0.02em;
  text-align: center;
  margin: 0;
  animation: fade-slide-up @duration-normal @ease-out 100ms both;
}

.hero-subtitle {
  font-size: @font-base;
  color: @color-text-secondary;
  text-align: center;
  margin: 0;
  animation: fade-slide-up @duration-normal @ease-out 150ms both;
}

.prompt-box {
  width: 100%;
  background: @color-bg-surface;
  border: 1px solid @color-border;
  border-radius: @radius-card;
  box-shadow: @shadow-card;
  padding: @space-3;
  animation: fade-slide-up @duration-normal @ease-out 200ms both;
  transition: border-color @duration-fast, box-shadow @duration-fast;

  &:focus-within {
    border-color: @primary;
    box-shadow: 0 0 0 3px @primary-glow, @shadow-card;
  }

  &.compact {
    border-radius: @radius-lg;
    box-shadow: @shadow-md;
  }
}

.prompt-textarea {
  position: relative;

  textarea {
    width: 100%;
    border: none;
    outline: none;
    resize: none;
    padding: @space-3 @space-12 @space-3 @space-3;
    font-size: @font-base;
    font-family: inherit;
    color: @color-text;
    background: transparent;
    line-height: 1.6;
    max-height: 200px;

    &::placeholder {
      color: @color-text-tertiary;
    }
  }

  .send-btn {
    position: absolute;
    right: 8px;
    bottom: 8px;
    width: 36px;
    height: 36px;
    border: none;
    border-radius: @radius-md;
    background: @color-bg-hover;
    color: @color-text-tertiary;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all @duration-fast;
    font-size: 16px;

    &.active {
      background: @primary;
      color: #fff;
      box-shadow: 0 2px 8px @primary-shadow;

      &:hover {
        background: @primary-hover;
      }
    }

    &:disabled {
      cursor: not-allowed;
    }
  }
}

.prompt-actions {
  display: flex;
  align-items: center;
  gap: @space-2;
  padding: @space-2 @space-1;
  flex-wrap: wrap;
}

.chip-wrapper {
  position: relative;
}

.action-chip {
  display: inline-flex;
  align-items: center;
  gap: @space-1;
  padding: 4px @space-2;
  border: 1px solid @color-border;
  border-radius: @radius-pill;
  background: transparent;
  color: @color-text-secondary;
  font-size: @font-xs;
  font-weight: 500;
  cursor: pointer;
  transition: all @duration-fast;

  &:hover {
    background: @color-bg-hover;
    color: @color-text;
    border-color: @color-border-strong;
  }

  &.tiny {
    padding: 2px @space-2;
    font-size: 11px;
  }

  &.clear {
    color: @color-text-tertiary;
  }

  .caret {
    font-size: 10px;
  }
}

.chip-divider {
  width: 1px;
  height: 16px;
  background: @color-border;
  margin: 0 @space-1;
}

.chip-dropdown {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  min-width: 200px;
  max-height: 280px;
  overflow-y: auto;
  background: @color-bg-surface;
  border: 1px solid @color-border;
  border-radius: @radius-lg;
  box-shadow: @shadow-float;
  padding: @space-2;
  z-index: 100;

  &.model {
    min-width: 220px;
  }

  &.bottom-anchored {
    bottom: auto;
    top: calc(100% + 6px);
  }

  .dropdown-title {
    font-size: 11px;
    font-weight: 600;
    color: @color-text-tertiary;
    padding: @space-1 @space-2;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .dropdown-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: @space-2 @space-3;
    border-radius: @radius-md;
    font-size: @font-sm;
    color: @color-text;
    cursor: pointer;
    transition: background-color @duration-fast;

    &:hover {
      background: @color-bg-hover;
    }

    &.active {
      background: @primary-light;
      color: @primary;
    }
  }

  .dropdown-empty {
    padding: @space-3;
    text-align: center;
    font-size: @font-sm;
    color: @color-text-tertiary;
  }
}

.suggestions {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: @space-3;
  width: 100%;
  animation: fade-slide-up @duration-normal @ease-out 300ms both;
}

.suggestion-card {
  display: flex;
  align-items: center;
  gap: @space-3;
  padding: @space-4;
  background: @color-bg-surface;
  border: 1px solid @color-border;
  border-radius: @radius-lg;
  cursor: pointer;
  text-align: left;
  transition: all 180ms @ease-standard;

  &:hover {
    border-color: @primary;
    background: @primary-light;
    transform: translateY(-2px);
    box-shadow: @shadow-sm;

    .suggestion-icon {
      background: @primary;
      color: #fff;
    }

    .suggestion-arrow {
      opacity: 1;
      transform: translateX(2px);
    }
  }

  .suggestion-icon {
    width: 36px;
    height: 36px;
    border-radius: @radius-md;
    background: @color-bg-hover;
    color: @color-text-secondary;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    flex-shrink: 0;
    transition: all 180ms @ease-standard;
  }

  .suggestion-content {
    flex: 1;
    min-width: 0;
  }

  .suggestion-label {
    font-size: @font-sm;
    font-weight: 600;
    color: @color-text;
    margin-bottom: 2px;
  }

  .suggestion-desc {
    font-size: @font-xs;
    color: @color-text-tertiary;
  }

  .suggestion-arrow {
    color: @color-text-tertiary;
    opacity: 0;
    transform: translateX(-2px);
    transition: all 180ms @ease-standard;
  }
}

/* ========== 聊天布局 ========== */
.chat-layout {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: @space-8 @space-12;
  display: flex;
  flex-direction: column;
  gap: @space-6;
}

.message-item {
  display: flex;
  gap: @space-4;
  max-width: 800px;
  margin: 0 auto;
  width: 100%;
  animation: fade-slide-up @duration-normal @ease-out;

  &.user {
    flex-direction: row-reverse;

    .message-body {
      align-items: flex-end;
    }

    .message-content {
      background: @primary;
      color: #fff;
    }

    .message-meta {
      flex-direction: row-reverse;
    }
  }

  .message-avatar {
    width: 36px;
    height: 36px;
    border-radius: @radius-lg;
    background: @color-bg-hover;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    flex-shrink: 0;

    .assistant & {
      background: linear-gradient(135deg, @primary 0%, lighten(@primary, 8%) 100%);
      color: #fff;
    }
  }

  .message-body {
    display: flex;
    flex-direction: column;
    gap: @space-1;
    max-width: 70%;
    min-width: 0;
  }

  .message-meta {
    display: flex;
    gap: @space-2;
    font-size: @font-xs;
    color: @color-text-tertiary;

    .message-role {
      font-weight: 500;
      color: @color-text-secondary;
    }
  }

  .message-content {
    padding: @space-3 @space-4;
    background: @color-bg-surface;
    border: 1px solid @color-border;
    border-radius: @radius-lg;
    line-height: 1.7;
    font-size: @font-base;
    white-space: pre-wrap;
    word-break: break-word;
    width: 100%;

    .assistant & {
      background: @color-bg-surface;
    }

    .typing {
      display: flex;
      gap: 4px;
      padding: @space-3 @space-5;

      span {
        width: 8px;
        height: 8px;
        background: @color-text-tertiary;
        border-radius: 50%;
        animation: typing-bounce 1.4s infinite ease-in-out both;

        &:nth-child(1) {
          animation-delay: -0.32s;
        }

        &:nth-child(2) {
          animation-delay: -0.16s;
        }
      }
    }
  }
}

.chat-input-bottom {
  padding: @space-4 @space-12 @space-8;
  max-width: 800px;
  margin: 0 auto;
  width: 100%;
}
</style>
