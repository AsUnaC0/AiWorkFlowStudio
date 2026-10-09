<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, nextTick, watch } from "vue";
import {
  listAgents,
  createAgent,
  deleteAgent,
  listSessions,
  createSession,
  deleteSession,
  getSession,
  runAgentStream,
  type Agent,
  type ChatSessionListItem,
  type ChatMessage,
  type AgentStreamEvent,
} from "@/api/agent";
import { AGENT_TEMPLATES, type AgentType } from "@/types/agent";
import { MessagePlugin, DialogPlugin } from "tdesign-vue-next";

// ===========================================================================
// 状态
// ===========================================================================

// Agent 列表
const agents = ref<Agent[]>([]);
const loadingAgents = ref(false);

// 当前选中的 Agent
const currentAgentId = ref<string>("");

// 会话列表（当前 Agent 下）
const sessions = ref<ChatSessionListItem[]>([]);
const loadingSessions = ref(false);

// 当前选中的会话
const currentSessionId = ref<string>("");

// 聊天消息
const messages = ref<ChatMessage[]>([]);
const loadingMessages = ref(false);

// 发送状态
const sending = ref(false);
const inputText = ref("");
const inputRef = ref<HTMLTextAreaElement | null>(null);
const chatContainerRef = ref<HTMLElement | null>(null);

// Trail 展开控制
const expandedTrails = ref<Set<string>>(new Set());
const toggleTrail = (msgId: string) => {
  if (expandedTrails.value.has(msgId)) expandedTrails.value.delete(msgId);
  else expandedTrails.value.add(msgId);
};

// 侧边栏折叠
const sidebarCollapsed = ref(false);

// 创建 Agent 对话框
const showCreateDialog = ref(false);
const creatingAgent = ref({
  name: "",
  type: "CUSTOM" as AgentType,
  description: "",
});
const creatingAgentLoading = ref(false);

// ===========================================================================
// 计算属性
// ===========================================================================

const currentAgent = computed(() =>
  agents.value.find((a) => a.id === currentAgentId.value),
);

const currentSession = computed(() =>
  sessions.value.find((s) => s.id === currentSessionId.value),
);

const isEmpty = computed(() => messages.value.length === 0);

const canSend = computed(
  () => !sending.value && currentAgentId.value && inputText.value.trim(),
);

// ===========================================================================
// 加载函数
// ===========================================================================

const loadAgents = async () => {
  loadingAgents.value = true;
  try {
    agents.value = await listAgents();

    // 如果没有选中 Agent，选中默认的第一个
    if (!currentAgentId.value && agents.value.length > 0) {
      // 优先选 isDefault 的
      const defaultAgent = agents.value.find((a) => a.isDefault);
      currentAgentId.value = defaultAgent?.id ?? agents.value[0].id;
    }
  } catch (err) {
    MessagePlugin.error("加载 Agent 列表失败");
  } finally {
    loadingAgents.value = false;
  }
};

const loadSessions = async () => {
  if (!currentAgentId.value) {
    sessions.value = [];
    return;
  }
  loadingSessions.value = true;
  try {
    sessions.value = await listSessions(currentAgentId.value);

    // 如果有会话，选中第一个
    if (sessions.value.length > 0 && !currentSessionId.value) {
      currentSessionId.value = sessions.value[0].id;
      await loadMessages();
    } else if (sessions.value.length === 0) {
      currentSessionId.value = "";
      messages.value = [];
    }
  } catch {
    sessions.value = [];
  } finally {
    loadingSessions.value = false;
  }
};

const loadMessages = async () => {
  if (!currentSessionId.value) {
    messages.value = [];
    return;
  }
  loadingMessages.value = true;
  try {
    const detail = await getSession(currentSessionId.value);
    messages.value = detail.messages.filter(
      (m) => m.role === "user" || m.role === "assistant",
    );
  } catch {
    messages.value = [];
  } finally {
    loadingMessages.value = false;
  }
};

// ===========================================================================
// 切换 Agent
// ===========================================================================

const switchAgent = (agentId: string) => {
  if (agentId === currentAgentId.value) return;
  currentAgentId.value = agentId;
  // watch(currentAgentId) 会自动触发 loadSessions
};

// 监听 Agent 变化，重新加载会话
watch(currentAgentId, async () => {
  currentSessionId.value = "";
  messages.value = [];
  sessions.value = [];
  await loadSessions();
});

// ===========================================================================
// 会话操作
// ===========================================================================

const createNewSession = async () => {
  if (!currentAgentId.value) return;
  try {
    const session = await createSession(currentAgentId.value, "新对话");
    currentSessionId.value = session.id;
    await loadSessions();
    messages.value = [];
    inputRef.value?.focus();
  } catch {
    MessagePlugin.error("创建会话失败");
  }
};

const switchSession = async (sessionId: string) => {
  if (sessionId === currentSessionId.value) return;
  currentSessionId.value = sessionId;
  await loadMessages();
};

const handleDeleteSession = async (sessionId: string) => {
  const confirmDialog = DialogPlugin.confirm({
    header: "确认删除",
    body: "确定要删除这个会话吗？删除后无法恢复。",
    confirmBtn: { content: "删除", theme: "danger" },
    cancelBtn: { content: "取消" },
    onConfirm: async () => {
      try {
        await deleteSession(sessionId);
        if (sessionId === currentSessionId.value) {
          currentSessionId.value = "";
          messages.value = [];
        }
        await loadSessions();
        confirmDialog.destroy();
      } catch {
        MessagePlugin.error("删除会话失败");
      }
    },
    onClose: () => confirmDialog.destroy(),
  });
};

// ===========================================================================
// 创建 Agent
// ===========================================================================

const openCreateDialog = (type?: AgentType) => {
  creatingAgent.value = {
    name: "",
    type: type ?? "CUSTOM",
    description: "",
  };
  showCreateDialog.value = true;
};

const handleCreateAgent = async () => {
  const { name, type, description } = creatingAgent.value;
  if (!name.trim()) {
    MessagePlugin.warning("请输入 Agent 名称");
    return;
  }

  creatingAgentLoading.value = true;
  try {
    const agent = await createAgent({
      name: name.trim(),
      type,
      description: description.trim() || undefined,
    });
    showCreateDialog.value = false;
    MessagePlugin.success("Agent 创建成功");

    // 刷新列表并选中新创建的 Agent
    await loadAgents();
    currentAgentId.value = agent.id;
  } catch (err) {
    MessagePlugin.error("创建 Agent 失败");
  } finally {
    creatingAgentLoading.value = false;
  }
};

const handleDeleteAgent = async (agentId: string) => {
  const agent = agents.value.find((a) => a.id === agentId);
  if (!agent) return;

  if (agent.isDefault) {
    MessagePlugin.warning("默认 Agent 不能删除");
    return;
  }

  const confirmDialog = DialogPlugin.confirm({
    header: "确认删除",
    body: `确定要删除 Agent「${agent.name}」吗？该 Agent 下的所有会话也会被删除。`,
    confirmBtn: { content: "删除", theme: "danger" },
    cancelBtn: { content: "取消" },
    onConfirm: async () => {
      try {
        await deleteAgent(agentId);
        // 如果删除的是当前 Agent，切换到第一个
        if (agentId === currentAgentId.value) {
          currentAgentId.value = "";
        }
        await loadAgents();
        confirmDialog.destroy();
        MessagePlugin.success("Agent 已删除");
      } catch (err) {
        MessagePlugin.error("删除 Agent 失败");
      }
    },
    onClose: () => confirmDialog.destroy(),
  });
};

// ===========================================================================
// 聊天交互
// ===========================================================================

const scrollToBottom = async () => {
  await nextTick();
  if (chatContainerRef.value) {
    chatContainerRef.value.scrollTo({
      top: chatContainerRef.value.scrollHeight,
      behavior: "smooth",
    });
  }
};

const handleAgentEvent = (event: AgentStreamEvent, assistantMsgId: string) => {
  const msg = messages.value.find((m) => m.id === assistantMsgId);
  if (!msg) return;

  switch (event.type) {
    case "thinking":
    case "tool_call":
    case "tool_result": {
      if (!msg.trail) msg.trail = [];
      msg.trail.push(event);
      break;
    }
    case "message": {
      msg.content = event.content;
      break;
    }
    case "error": {
      msg.content = `⚠️ ${event.message}`;
      break;
    }
  }
  scrollToBottom();
};

const send = async () => {
  if (!canSend.value || !currentAgentId.value) return;

  // 确保有会话
  if (!currentSessionId.value) {
    const session = await createSession(currentAgentId.value, "新对话");
    currentSessionId.value = session.id;
    await loadSessions();
  }

  const userText = inputText.value.trim();
  inputText.value = "";

  // 添加用户消息到界面
  messages.value.push({
    id: `temp-user-${Date.now()}`,
    sessionId: currentSessionId.value,
    role: "user",
    content: userText,
    createdAt: new Date().toISOString(),
  });

  // 添加空的 assistant 消息（等待 SSE 填充）
  const assistantMsgId = `temp-assistant-${Date.now()}`;
  messages.value.push({
    id: assistantMsgId,
    sessionId: currentSessionId.value,
    role: "assistant",
    content: "",
    trail: [],
    createdAt: new Date().toISOString(),
  });

  sending.value = true;
  scrollToBottom();

  try {
    await runAgentStream(
      {
        agentId: currentAgentId.value,
        sessionId: currentSessionId.value,
        input: userText,
      },
      (event) => handleAgentEvent(event, assistantMsgId),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Agent 请求失败";
    MessagePlugin.error(msg);
  } finally {
    sending.value = false;
    // 消息会在 SSE 过程中被逐步填充
    // 最后刷新一下会话列表更新 updatedAt
    loadSessions();
    scrollToBottom();
  }
};

const onKeydown = (e: KeyboardEvent) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
};

const formatTime = (iso: string) => {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
};

// ===========================================================================
// 生命周期
// ===========================================================================

onMounted(async () => {
  await loadAgents();
});

onBeforeUnmount(() => {
  agents.value = [];
  sessions.value = [];
  messages.value = [];
});

// ===========================================================================
// 辅助函数
// ===========================================================================

const getAgentTemplate = (type: AgentType) =>
  AGENT_TEMPLATES.find((t) => t.type === type);

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
    <!-- Agent 侧边栏 -->
    <aside class="agent-sidebar" :class="{ collapsed: sidebarCollapsed }">
      <!-- 折叠按钮 -->
      <button class="sidebar-toggle" @click="sidebarCollapsed = !sidebarCollapsed">
        <t-icon :name="sidebarCollapsed ? 'chevron-right' : 'chevron-left'" />
      </button>

      <div v-if="!sidebarCollapsed" class="sidebar-content">
        <!-- Agent 列表 -->
        <div class="agent-section">
          <div class="section-header">
            <span class="section-title">我的 Agent</span>
            <button class="create-btn" @click="openCreateDialog()">
              <t-icon name="add" />
              <span>新建</span>
            </button>
          </div>

          <div class="agent-list">
            <button v-for="agent in agents" :key="agent.id" class="agent-item"
              :class="{ active: agent.id === currentAgentId }" @click="switchAgent(agent.id)">
              <div class="agent-avatar" :class="agent.type.toLowerCase()">
                <t-icon :name="getAgentTemplate(agent.type)?.icon ?? 'chat'" />
              </div>
              <div class="agent-info">
                <div class="agent-name">
                  {{ agent.name }}
                  <t-tag v-if="agent.isDefault" theme="primary" variant="light" size="small" class="default-tag">
                    默认
                  </t-tag>
                </div>
                <div class="agent-desc">
                  {{ agent.description || agent.type.toLowerCase() }}
                </div>
              </div>
              <t-icon v-if="!agent.isDefault" name="delete" class="agent-delete"
                @click.stop="handleDeleteAgent(agent.id)" />
            </button>

            <div v-if="agents.length === 0 && !loadingAgents" class="agent-empty">
              <p>暂无 Agent</p>
              <button class="create-btn" @click="openCreateDialog()">
                <t-icon name="add" />
                <span>创建第一个 Agent</span>
              </button>
            </div>
          </div>
        </div>

        <!-- 会话列表 -->
        <div v-if="currentAgent" class="session-section">
          <div class="section-header">
            <span class="section-title">会话</span>
            <button class="create-btn text-only" @click="createNewSession">
              <t-icon name="add" />
            </button>
          </div>

          <div class="session-list">
            <div v-for="session in sessions" :key="session.id" class="session-item"
              :class="{ active: session.id === currentSessionId }">
              <button class="session-main" @click="switchSession(session.id)">
                <t-icon name="chat" class="session-icon" />
                <span class="session-title">{{ session.title }}</span>
                <span class="session-time">{{ formatTime(session.updatedAt) }}</span>
              </button>
              <button class="session-delete" title="删除会话" @click="handleDeleteSession(session.id)">
                <t-icon name="close" />
              </button>
            </div>

            <div v-if="sessions.length === 0 && !loadingSessions" class="session-empty">
              暂无会话，开始你的第一条消息吧
            </div>
          </div>
        </div>
      </div>
    </aside>

    <!-- 聊天主体 -->
    <main class="chat-main">
      <!-- Agent 头部信息 -->
      <header v-if="currentAgent" class="chat-header">
        <div class="header-left">
          <div class="agent-avatar lg" :class="currentAgent.type.toLowerCase()">
            <t-icon :name="getAgentTemplate(currentAgent.type)?.icon ?? 'chat'" />
          </div>
          <div class="agent-meta">
            <h2 class="agent-title">
              {{ currentAgent.name }}
              <t-tag v-if="currentAgent.isDefault" theme="primary" variant="light" size="small">
                默认
              </t-tag>
            </h2>
            <p class="agent-desc-sm">
              {{ currentAgent.description || currentAgent.type.toLowerCase() }}
            </p>
          </div>
        </div>
        <div class="header-right">
          <span class="model-chip">{{ currentAgent.model }}</span>
          <button v-if="currentSessionId" class="new-chat-btn" @click="createNewSession">
            <t-icon name="add" />
            <span>新对话</span>
          </button>
        </div>
      </header>

      <!-- 空状态 -->
      <template v-if="isEmpty && !loadingMessages">
        <div class="hero-section">
          <div class="hero-content">
            <div class="hero-logo">✦</div>
            <h1 class="hero-title">与 {{ currentAgent?.name }} 对话</h1>
            <p class="hero-subtitle">
              {{ currentAgent?.description || "输入问题开始对话" }}
            </p>

            <div class="prompt-box">
              <div class="prompt-textarea">
                <textarea ref="inputRef" v-model="inputText" placeholder="Ask anything..."
                  :disabled="sending || !currentAgentId" rows="1" @keydown="onKeydown" />
                <button class="send-btn" :class="{ active: canSend }" :disabled="!canSend" @click="send">
                  <t-icon :name="sending ? 'loading' : 'send'" :spin="sending" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- 有消息后：标准聊天布局 -->
      <template v-else>
        <div class="chat-layout">
          <div ref="chatContainerRef" class="chat-messages">
            <div v-for="msg in messages" :key="msg.id" class="message-item" :class="msg.role">
              <div class="message-avatar">
                <template v-if="msg.role === 'user'">👤</template>
                <template v-else>✦</template>
              </div>
              <div class="message-body">
                <div class="message-meta">
                  <span class="message-role">
                    {{ msg.role === "user" ? "你" : currentAgent?.name }}
                  </span>
                  <span class="message-time">{{ formatTime(msg.createdAt) }}</span>
                </div>

                <!-- 执行轨迹 trail（只有 assistant 有） -->
                <div v-if="msg.trail && msg.trail.length > 0" class="trail">
                  <div v-for="(step, sIdx) in msg.trail" :key="sIdx" class="trail-step" :class="step.type">
                    <template v-if="step.type === 'thinking'">
                      <span class="step-icon">💭</span>
                      <span class="step-text">{{ (step as any).message }}</span>
                    </template>

                    <template v-else-if="step.type === 'tool_call'">
                      <span class="step-icon">🔧</span>
                      <button class="tool-toggle" @click="toggleTrail(msg.id)">
                        调用 <code>{{ (step as any).tool }}</code>
                      </button>
                      <pre v-if="expandedTrails.has(msg.id)"
                        class="tool-args">{{ formatToolArgs((step as any).args) }}</pre>
                    </template>

                    <template v-else-if="step.type === 'tool_result'">
                      <span class="step-icon">✅</span>
                      <span class="step-text" v-if="(step as any).durationMs">
                        返回结果（{{ (step as any).durationMs }}ms）
                      </span>
                      <button v-else class="tool-toggle" @click="toggleTrail(msg.id)">返回结果</button>
                      <pre v-if="expandedTrails.has(msg.id)"
                        class="tool-result">{{ formatToolResult((step as any).result) }}</pre>
                    </template>
                  </div>
                </div>

                <div class="message-content">
                  {{ msg.content || (sending && msg.role === "assistant" ? "" : "") }}
                  <div
                    v-if="sending && msg.role === 'assistant' && !msg.content && (!msg.trail || msg.trail.length === 0)"
                    class="typing">
                    <span></span><span></span><span></span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="chat-input-bottom">
            <div class="prompt-box compact">
              <div class="prompt-textarea">
                <textarea ref="inputRef" v-model="inputText" placeholder="继续对话..."
                  :disabled="sending || !currentAgentId" rows="1" @keydown="onKeydown" />
                <button class="send-btn" :class="{ active: canSend }" :disabled="!canSend" @click="send">
                  <t-icon :name="sending ? 'loading' : 'send'" :spin="sending" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </template>
    </main>

    <!-- 创建 Agent 对话框 -->
    <t-dialog v-if="showCreateDialog" header="创建 Agent" :footer="false" :width="480" @close="showCreateDialog = false">
      <div class="create-agent-form">
        <div class="form-item">
          <label>选择类型</label>
          <div class="template-grid">
            <button v-for="tpl in AGENT_TEMPLATES" :key="tpl.type" class="template-card"
              :class="{ active: creatingAgent.type === tpl.type }" @click="creatingAgent.type = tpl.type">
              <t-icon :name="tpl.icon" />
              <div class="tpl-info">
                <span class="tpl-label">{{ tpl.label }}</span>
                <span class="tpl-desc">{{ tpl.description }}</span>
              </div>
            </button>
          </div>
        </div>

        <div class="form-item">
          <label>Agent 名称</label>
          <input v-model="creatingAgent.name" type="text" class="form-input"
            :placeholder="getAgentTemplate(creatingAgent.type)?.defaultName" maxlength="50" />
        </div>

        <div class="form-item">
          <label>描述（可选）</label>
          <textarea v-model="creatingAgent.description" class="form-textarea" placeholder="帮助我分析销售数据并生成结论。" rows="2"
            maxlength="200" />
        </div>

        <div class="form-actions">
          <t-button theme="default" @click="showCreateDialog = false">
            取消
          </t-button>
          <t-button theme="primary" :loading="creatingAgentLoading" @click="handleCreateAgent">
            创建 Agent
          </t-button>
        </div>
      </div>
    </t-dialog>
  </div>
</template>

<style scoped lang="less">
@import "../../styles/variables.less";

.chat-page {
  height: 100%;
  width: 100%;
  display: flex;
  position: relative;
  overflow: hidden;
}

// ===========================================================================
// Agent 侧边栏
// ===========================================================================

.agent-sidebar {
  width: 280px;
  flex-shrink: 0;
  background: @color-bg-surface;
  border-right: 1px solid @color-border;
  display: flex;
  flex-direction: column;
  transition: width @duration-normal @ease-standard;
  position: relative;

  &.collapsed {
    width: 0;
    overflow: visible;

    .sidebar-content {
      display: none;
    }
  }
}

.sidebar-toggle {
  position: absolute;
  top: 12px;
  right: -14px;
  z-index: 10;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1px solid @color-border;
  background: @color-bg-surface;
  color: @color-text-tertiary;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  transition: all @duration-fast;

  &:hover {
    color: @primary;
    border-color: @primary;
    box-shadow: @shadow-sm;
  }
}

.sidebar-content {
  flex: 1;
  overflow-y: auto;
  padding: @space-3;
  display: flex;
  flex-direction: column;
  gap: @space-4;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: @space-2;

  .section-title {
    font-size: 11px;
    font-weight: 600;
    color: @color-text-tertiary;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .create-btn {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 3px 8px;
    border: 1px solid @color-border;
    border-radius: @radius-pill;
    background: transparent;
    color: @color-text-secondary;
    font-size: 11px;
    cursor: pointer;
    transition: all @duration-fast;

    &:hover {
      background: @primary-light;
      color: @primary;
      border-color: @primary;
    }

    &.text-only {
      border: none;
      padding: 2px;
    }
  }
}

// Agent 列表
.agent-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.agent-item {
  display: flex;
  align-items: center;
  gap: @space-2;
  padding: @space-2 @space-3;
  border-radius: @radius-md;
  background: transparent;
  border: none;
  cursor: pointer;
  width: 100%;
  text-align: left;
  transition: all @duration-fast;
  position: relative;

  &:hover {
    background: @color-bg-hover;
  }

  &.active {
    background: @primary-light;
  }

  .agent-avatar {
    width: 32px;
    height: 32px;
    border-radius: @radius-md;
    background: @color-bg-hover;
    color: @color-text-secondary;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    flex-shrink: 0;

    &.general {
      background: rgba(99, 102, 241, 0.1);
      color: #6366f1;
    }

    &.knowledge {
      background: rgba(34, 197, 94, 0.1);
      color: #22c55e;
    }

    &.workflow {
      background: rgba(249, 115, 22, 0.1);
      color: #f97316;
    }

    &.tool {
      background: rgba(236, 72, 153, 0.1);
      color: #ec4899;
    }

    &.custom {
      background: rgba(139, 92, 246, 0.1);
      color: #8b5cf6;
    }

    &.lg {
      width: 40px;
      height: 40px;
      font-size: 20px;
      border-radius: @radius-lg;
    }
  }

  .agent-info {
    flex: 1;
    min-width: 0;

    .agent-name {
      font-size: @font-sm;
      font-weight: 600;
      color: @color-text;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .agent-desc {
      font-size: 11px;
      color: @color-text-tertiary;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }

  .agent-delete {
    font-size: 12px;
    color: @color-text-tertiary;
    opacity: 0;
    transition: opacity @duration-fast;

    .agent-item:hover & {
      opacity: 1;
    }
  }

  .default-tag {
    flex-shrink: 0;
  }
}

.agent-empty {
  padding: @space-4;
  text-align: center;
  color: @color-text-tertiary;
  font-size: @font-sm;
  display: flex;
  flex-direction: column;
  gap: @space-3;

  .create-btn {
    margin: 0 auto;
    display: inline-flex;
    align-items: center;
    gap: @space-1;
    padding: @space-2 @space-3;
    background: @primary;
    color: #fff;
    border: none;
    border-radius: @radius-md;
    font-size: @font-sm;
    cursor: pointer;
  }
}

// 会话列表
.session-section {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.session-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
}

.session-item {
  display: flex;
  align-items: center;
  border-radius: @radius-md;
  background: transparent;
  transition: all @duration-fast;
  position: relative;

  .session-main {
    display: flex;
    align-items: center;
    gap: @space-2;
    padding: @space-2 @space-3;
    border: none;
    background: transparent;
    cursor: pointer;
    width: 100%;
    text-align: left;
  }

  &:hover {
    background: @color-bg-hover;

    .session-delete {
      opacity: 1;
      pointer-events: auto;
    }

    .session-time {
      opacity: 0;
    }
  }

  &.active {
    background: @color-bg-hover;

    .session-delete {
      opacity: 1;
      pointer-events: auto;
    }

    .session-time {
      opacity: 0;
    }
  }

  .session-icon {
    font-size: 14px;
    color: @color-text-tertiary;
    flex-shrink: 0;
  }

  .session-title {
    flex: 1;
    font-size: @font-sm;
    color: @color-text-secondary;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .session-time {
    font-size: 10px;
    color: @color-text-tertiary;
    flex-shrink: 0;
    transition: opacity @duration-fast;
  }

  .session-delete {
    opacity: 0;
    pointer-events: none;
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    border-radius: @radius-sm;
    color: @color-text-tertiary;
    cursor: pointer;
    margin-right: 4px;
    transition: all @duration-fast;

    &:hover {
      background: rgba(239, 68, 68, 0.1);
      color: #ef4444;
      opacity: 1 !important;
    }

    .t-icon {
      font-size: 12px;
    }
  }
}

.session-empty {
  padding: @space-4;
  text-align: center;
  font-size: 12px;
  color: @color-text-tertiary;
}

// ===========================================================================
// 聊天主体
// ===========================================================================

.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: @space-4 @space-8;
  border-bottom: 1px solid @color-border;
  background: @color-bg-surface;
  flex-shrink: 0;

  .header-left {
    display: flex;
    align-items: center;
    gap: @space-3;
  }

  .agent-meta {
    .agent-title {
      font-size: @font-lg;
      font-weight: 600;
      color: @color-text;
      margin: 0;
      display: flex;
      align-items: center;
      gap: @space-2;
    }

    .agent-desc-sm {
      font-size: @font-sm;
      color: @color-text-tertiary;
      margin: 2px 0 0;
    }
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: @space-2;
  }

  .model-chip {
    padding: 4px 10px;
    font-size: 11px;
    color: @color-text-secondary;
    background: @color-bg-hover;
    border-radius: @radius-pill;
  }

  .new-chat-btn {
    display: inline-flex;
    align-items: center;
    gap: @space-1;
    padding: 6px 12px;
    background: @primary;
    color: #fff;
    border: none;
    border-radius: @radius-md;
    font-size: @font-sm;
    cursor: pointer;
    transition: all @duration-fast;

    &:hover {
      background: @primary-hover;
    }
  }
}

// Hero 空状态
.hero-section {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: @space-12 @space-8;
}

.hero-content {
  width: 100%;
  max-width: 680px;
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
}

.hero-title {
  font-size: @font-hero;
  font-weight: 700;
  color: @color-text;
  letter-spacing: -0.02em;
  margin: 0;
  text-align: center;
}

.hero-subtitle {
  font-size: @font-base;
  color: @color-text-secondary;
  text-align: center;
  margin: 0;
}

// Prompt box（复用 chat 页面的样式）
.prompt-box {
  width: 100%;
  background: @color-bg-surface;
  border: 1px solid @color-border;
  border-radius: @radius-card;
  box-shadow: @shadow-card;
  padding: @space-3;
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

// 聊天布局
.chat-layout {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
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
    min-height: 20px;

    .typing {
      display: flex;
      gap: 4px;
      padding: @space-2 0;

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

// Trail 样式（复用）
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

.chat-input-bottom {
  padding: @space-4 @space-12 @space-8;
  max-width: 800px;
  margin: 0 auto;
  width: 100%;
  flex-shrink: 0;
}

// ===========================================================================
// 创建 Agent 对话框
// ===========================================================================

.create-agent-form {
  display: flex;
  flex-direction: column;
  gap: @space-5;
  padding: @space-2 0;

  .form-item {
    display: flex;
    flex-direction: column;
    gap: @space-2;

    label {
      font-size: @font-sm;
      font-weight: 500;
      color: @color-text-secondary;
    }
  }

  .template-grid {
    display: flex;
    flex-direction: column;
    gap: @space-2;
  }

  .template-card {
    display: flex;
    align-items: flex-start;
    gap: @space-3;
    padding: @space-3;
    border: 1px solid @color-border;
    border-radius: @radius-lg;
    background: transparent;
    cursor: pointer;
    text-align: left;
    transition: all @duration-fast;

    &:hover {
      border-color: @primary;
      background: @primary-light;
    }

    &.active {
      border-color: @primary;
      background: @primary-light;
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
    }

    >t-icon {
      font-size: 18px;
      color: @color-text-secondary;
      flex-shrink: 0;
      margin-top: 2px;
    }

    .tpl-info {
      display: flex;
      flex-direction: column;
      gap: 2px;

      .tpl-label {
        font-size: @font-sm;
        font-weight: 600;
        color: @color-text;
      }

      .tpl-desc {
        font-size: 12px;
        color: @color-text-tertiary;
        line-height: 1.4;
      }
    }
  }

  .form-input,
  .form-textarea {
    width: 100%;
    padding: @space-2 @space-3;
    border: 1px solid @color-border;
    border-radius: @radius-md;
    background: @color-bg-surface;
    font-size: @font-base;
    color: @color-text;
    font-family: inherit;
    outline: none;
    transition: all @duration-fast;

    &:focus {
      border-color: @primary;
      box-shadow: 0 0 0 3px @primary-glow;
    }
  }

  .form-textarea {
    resize: vertical;
    min-height: 60px;
  }

  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: @space-3;
    padding-top: @space-2;
    border-top: 1px solid @color-border;
  }
}
</style>
