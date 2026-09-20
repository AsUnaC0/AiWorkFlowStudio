<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { getModels, chat as chatApi, type AiModel, type ChatMessage } from "@/api/ai";
import { getKnowledgeBases, type KnowledgeBase } from "@/api/knowledge";
import { getWorkflows } from "@/api/workflow";
import { getWorkspaces } from "@/api/workspace";
import { useUserStore } from "@/stores/user";
import { MessagePlugin } from "tdesign-vue-next";

const userStore = useUserStore();

// ===========================================================================
// 状态
// ===========================================================================

const models = ref<AiModel[]>([]);
const selectedModel = ref("");
const modelsLoading = ref(false);

// 从用户的第一个 workspace 加载知识库和工作流
const workspaces = ref<{ id: string; name: string }[]>([]);
const knowledgeOptions = ref<KnowledgeBase[]>([]);
const workflowOptions = ref<{ id: string; name: string }[]>([]);
const kbLoading = ref(false);

const selectedKnowledgeIds = ref<string[]>([]); // 多选知识库
const selectedWorkflowIds = ref<string[]>([]); // 多选工作流（占位）

const inputText = ref("");
const sending = ref(false);

// 聊天历史（当前会话）
interface ChatItem {
  role: "user" | "assistant";
  content: string;
  time: string;
}
const messages = ref<ChatItem[]>([]);
const chatContainerRef = ref<HTMLElement | null>(null);

// ===========================================================================
// 初始化
// ===========================================================================

const loadModels = async () => {
  modelsLoading.value = true;
  try {
    const res = await getModels();
    models.value = res.models;
    if (res.models.length > 0 && !selectedModel.value) {
      // 优先选带 chat 能力的，排除 embedding 模型
      const chatModel = res.models.find(
        (m) => !m.name.includes("embed") && !m.name.includes("bge"),
      );
      selectedModel.value = chatModel?.name ?? res.models[0].name;
    }
  } catch {
    // Ollama 没启，用默认
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

const loadWorkspaceResources = async () => {
  kbLoading.value = true;
  try {
    const wsList = await getWorkspaces();
    workspaces.value = wsList.map((w) => ({ id: w.id, name: w.name }));

    // 知识库独立获取（owner 模型）；工作流仍按第一个 workspace 取
    const firstWsId = wsList[0]?.id;
    const [kbs, wfs] = await Promise.all([
      getKnowledgeBases().catch(() => []),
      firstWsId ? getWorkflows(firstWsId).catch(() => []) : Promise.resolve([]),
    ]);
    knowledgeOptions.value = kbs;
    workflowOptions.value = wfs.map((w) => ({ id: w.id, name: w.name }));
  } catch {
    // 用户可能还没有 workspace，忽略
  } finally {
    kbLoading.value = false;
  }
};

onMounted(() => {
  loadModels();
  loadWorkspaceResources();
});

onBeforeUnmount(() => {
  // 清理（暂无定时器）
});

// ===========================================================================
// 聊天交互
// ===========================================================================

const canSend = computed(
  () => !sending.value && selectedModel.value.trim() && inputText.value.trim(),
);

const appendMessage = (role: "user" | "assistant", content: string) => {
  messages.value.push({
    role,
    content,
    time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
  });
  // 滚动到底
  setTimeout(() => {
    if (chatContainerRef.value) {
      chatContainerRef.value.scrollTop = chatContainerRef.value.scrollHeight;
    }
  }, 50);
};

const send = async () => {
  if (!canSend.value) return;

  const userText = inputText.value.trim();
  inputText.value = "";
  appendMessage("user", userText);
  sending.value = true;

  try {
    // 组装消息历史（只传最近 10 条，避免 token 爆炸）
    const history: ChatMessage[] = messages.value
      .slice(-10)
      .map((m) => ({ role: m.role, content: m.content }));

    const res = await chatApi({
      model: selectedModel.value,
      messages: history,
      temperature: 0.7,
      knowledgeBaseIds: selectedKnowledgeIds.value,
    });

    appendMessage("assistant", res.content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "请求失败";
    MessagePlugin.error(`AI 响应失败：${msg}`);
    appendMessage("assistant", `❌ 抱歉，请求失败了：${msg}`);
  } finally {
    sending.value = false;
  }
};

const onKeydown = (e: KeyboardEvent) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
};

const clearChat = () => {
  messages.value = [];
};

const hasKnowledgeSelected = computed(() => selectedKnowledgeIds.value.length > 0);
const hasWorkflowSelected = computed(() => selectedWorkflowIds.value.length > 0);
</script>

<template>
  <div class="chat-page">
    <!-- 左侧：AI 配置面板 -->
    <aside class="chat-sidebar">
      <div class="sidebar-section">
        <div class="section-title">
          <t-icon name="server" />
          AI 模型
        </div>
        <t-loading :loading="modelsLoading" text="加载模型..." :delay="200">
          <t-select v-model="selectedModel" :placeholder="modelsLoading ? '加载中...' : '选择模型'"
            :popup-props="{ placement: 'right' }">
            <t-option v-for="m in models" :key="m.name" :value="m.name">
              {{ m.name }}
            </t-option>
          </t-select>
          <p v-if="models.length === 0 && !modelsLoading" class="helper-text">
            Ollama 未连接，使用默认模型
          </p>
        </t-loading>
      </div>

      <div class="sidebar-section">
        <div class="section-title">
          <t-icon name="library" />
          知识库
          <t-tag v-if="hasKnowledgeSelected" theme="primary" variant="light" class="count-tag">
            {{ selectedKnowledgeIds.length }}
          </t-tag>
        </div>
        <t-loading :loading="kbLoading" text="加载中..." :delay="200">
          <t-select v-model="selectedKnowledgeIds" multiple placeholder="选择知识库（可多选）"
            :disabled="knowledgeOptions.length === 0" :popup-props="{ placement: 'right' }">
            <t-option v-for="kb in knowledgeOptions" :key="kb.id" :value="kb.id">
              {{ kb.name }}
              <span class="option-suffix">
                {{ kb.documentCount }}文档 · {{ kb.embeddingModel }}
              </span>
            </t-option>
          </t-select>
          <p v-if="knowledgeOptions.length === 0 && !kbLoading" class="helper-text">
            还没有知识库，去侧边栏「知识库」创建
          </p>
        </t-loading>
      </div>

      <div class="sidebar-section">
        <div class="section-title">
          <t-icon name="flow" />
          工作流
          <t-tag v-if="hasWorkflowSelected" theme="primary" variant="light" class="count-tag">
            {{ selectedWorkflowIds.length }}
          </t-tag>
        </div>
        <t-select v-model="selectedWorkflowIds" multiple placeholder="选择工作流（功能开发中）"
          :disabled="workflowOptions.length === 0 || true" :popup-props="{ placement: 'right' }">
          <t-option v-for="wf in workflowOptions" :key="wf.id" :value="wf.id">
            {{ wf.name }}
          </t-option>
        </t-select>
        <p class="helper-text">
          选择后 AI 将调用该工作流来回答（Agent 模式）
        </p>
      </div>

      <t-divider />

      <div class="sidebar-actions">
        <t-button variant="text" size="small" :disabled="messages.length === 0" @click="clearChat">
          <template #icon><t-icon name="delete" /></template>
          清空对话
        </t-button>
      </div>
    </aside>

    <!-- 中间：聊天区域 -->
    <main class="chat-main">
      <div class="chat-header">
        <span class="chat-title">AI 助手</span>
        <span class="chat-sub">使用 {{ selectedModel || '默认模型' }} 对话</span>
      </div>

      <!-- 聊天消息区 -->
      <div ref="chatContainerRef" class="chat-messages">
        <!-- 空状态 -->
        <template v-if="messages.length === 0">
          <div class="empty-state">
            <div class="empty-avatar">🤖</div>
            <div class="empty-title">你好，{{ userStore.userInfo?.username || '用户' }}！</div>
            <div class="empty-desc">我可以帮你问答、写作、分析数据……</div>

            <div class="suggestions">
              <div class="suggestion-item" @click="inputText = '帮我写一段产品介绍文案'">
                <div class="suggestion-icon">📝</div>
                <div>写一段产品介绍文案</div>
              </div>
              <div class="suggestion-item" @click="inputText = '用一句话总结什么是 RAG'">
                <div class="suggestion-icon">💡</div>
                <div>用一句话总结什么是 RAG</div>
              </div>
              <div class="suggestion-item" @click="inputText = '分析一下 AI WorkFlow Studio 可以用来做什么'">
                <div class="suggestion-icon">🔍</div>
                <div>分析 AI WorkFlow Studio 能做什么</div>
              </div>
            </div>

            <p v-if="hasKnowledgeSelected" class="rag-hint">
              📚 已选 {{ selectedKnowledgeIds.length }} 个知识库，回答将结合知识库内容
            </p>
          </div>
        </template>

        <!-- 消息列表 -->
        <template v-else>
          <div v-for="(msg, idx) in messages" :key="idx" class="chat-bubble" :class="msg.role">
            <div class="bubble-avatar">
              {{ msg.role === 'user' ? '👤' : '🤖' }}
            </div>
            <div class="bubble-body">
              <div class="bubble-meta">
                <span>{{ msg.role === 'user' ? '你' : 'AI' }}</span>
                <span class="bubble-time">{{ msg.time }}</span>
              </div>
              <div class="bubble-content">{{ msg.content }}</div>
            </div>
          </div>
        </template>

        <!-- 发送中指示器 -->
        <div v-if="sending" class="chat-bubble assistant">
          <div class="bubble-avatar">🤖</div>
          <div class="bubble-body">
            <div class="bubble-content typing">
              <span></span><span></span><span></span>
            </div>
          </div>
        </div>
      </div>

      <!-- 输入区 -->
      <div class="chat-input-area">
        <div class="input-wrapper">
          <t-textarea v-model="inputText" placeholder="输入你的问题，Enter 发送，Shift+Enter 换行" :autosize="{ minRows: 2, maxRows: 6 }"
            :disabled="sending" @keydown="onKeydown" />
          <div class="input-actions">
            <t-button theme="primary" size="large" :loading="sending" :disabled="!canSend" @click="send">
              <template #icon><t-icon name="send" /></template>
              发送
            </t-button>
          </div>
        </div>
        <div v-if="hasKnowledgeSelected || hasWorkflowSelected" class="input-tags">
          <t-tag v-if="hasKnowledgeSelected" theme="primary" variant="light" closable @close="selectedKnowledgeIds = []">
            📚 已选 {{ selectedKnowledgeIds.length }} 知识库
          </t-tag>
          <t-tag v-if="hasWorkflowSelected" theme="primary" variant="light" closable @close="selectedWorkflowIds = []">
            🔗 已选 {{ selectedWorkflowIds.length }} 工作流
          </t-tag>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped lang="less">
.chat-page {
  display: flex;
  min-height: 100%;
  padding: var(--space-4) var(--space-8) var(--space-8);
  box-sizing: border-box;
  gap: var(--space-5);
}

// ===========================================================================
// 左侧配置面板
// ===========================================================================

.chat-sidebar {
  width: 280px;
  flex-shrink: 0;
  background: var(--color-bg-white);
  border-radius: var(--radius-lg);
  padding: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  box-shadow: var(--shadow-base, 0 1px 2px rgba(0,0,0,0.04));

  .sidebar-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .section-title {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--font-sm);
    font-weight: 600;
    color: var(--color-text);

    .count-tag {
      margin-left: auto;
      font-size: 11px;
    }
  }

  .helper-text {
    margin: 0;
    font-size: 12px;
    color: var(--color-text-tertiary);
    line-height: 1.4;
  }

  .option-suffix {
    margin-left: 8px;
    font-size: 11px;
    color: var(--color-text-tertiary);
    font-weight: 400;
  }

  .sidebar-actions {
    margin-top: auto;
  }
}

// ===========================================================================
// 中间聊天区
// ===========================================================================

.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-white);
  border-radius: var(--radius-lg);
  overflow: hidden;
  min-width: 0;
}

.chat-header {
  padding: var(--space-4) var(--space-6);
  border-bottom: 1px solid var(--color-border);
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  flex-shrink: 0;

  .chat-title {
    font-size: var(--font-lg);
    font-weight: 600;
    color: var(--color-text);
  }

  .chat-sub {
    font-size: var(--font-sm);
    color: var(--color-text-tertiary);
  }
}

.chat-messages {
  flex: 1;
  padding: var(--space-6);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  min-height: 0;
}

// 空状态
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--space-10) var(--space-6);

  .empty-avatar {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: var(--primary-bg);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 28px;
    margin-bottom: var(--space-3);
  }

  .empty-title {
    font-size: var(--font-lg);
    font-weight: 600;
    color: var(--color-text);
    margin-bottom: 4px;
  }

  .empty-desc {
    font-size: var(--font-sm);
    color: var(--color-text-tertiary);
    margin-bottom: var(--space-6);
  }

  .suggestions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    justify-content: center;
    max-width: 520px;
  }

  .suggestion-item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    background: var(--color-bg-light);
    border: 1px solid var(--color-border-dashed);
    border-radius: var(--radius-md);
    font-size: var(--font-sm);
    color: var(--color-text);
    cursor: pointer;
    transition: all 0.15s ease;

    &:hover {
      background: var(--primary-bg);
      border-color: var(--primary);
      color: var(--primary);
    }

    .suggestion-icon {
      font-size: 16px;
    }
  }

  .rag-hint {
    margin-top: var(--space-6);
    padding: var(--space-2) var(--space-4);
    background: var(--primary-bg);
    border-radius: var(--radius-md);
    font-size: var(--font-sm);
    color: var(--primary);
  }
}

// 消息气泡
.chat-bubble {
  display: flex;
  gap: var(--space-3);

  &.user {
    flex-direction: row-reverse;

    .bubble-body {
      align-items: flex-end;
    }

    .bubble-content {
      background: var(--primary);
      color: #fff;
    }

    .bubble-meta {
      flex-direction: row-reverse;
    }
  }

  &.assistant {
    .bubble-content {
      background: var(--color-bg-light);
      color: var(--color-text);
    }
  }

  .bubble-avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--color-bg-light);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    flex-shrink: 0;
  }

  .bubble-body {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-width: 75%;
  }

  .bubble-meta {
    display: flex;
    gap: var(--space-2);
    font-size: 12px;
    color: var(--color-text-tertiary);
  }

  .bubble-content {
    padding: var(--space-3) var(--space-4);
    border-radius: 12px;
    line-height: 1.6;
    font-size: var(--font-sm);
    white-space: pre-wrap;
    word-break: break-word;
  }

  // 打字指示器
  .typing {
    display: flex;
    gap: 4px;
    padding: var(--space-3) var(--space-5);

    span {
      width: 8px;
      height: 8px;
      background: var(--color-text-tertiary);
      border-radius: 50%;
      animation: bounce 1.4s infinite ease-in-out both;

      &:nth-child(1) { animation-delay: -0.32s; }
      &:nth-child(2) { animation-delay: -0.16s; }
    }
  }
}

@keyframes bounce {
  0%, 80%, 100% { transform: scale(0); }
  40% { transform: scale(1); }
}

// 输入区
.chat-input-area {
  padding: var(--space-4) var(--space-6);
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-white);
  flex-shrink: 0;

  .input-wrapper {
    display: flex;
    gap: var(--space-3);
    align-items: flex-end;
  }

  .input-actions {
    flex-shrink: 0;
  }

  .input-tags {
    margin-top: var(--space-2);
    display: flex;
    gap: var(--space-2);
  }
}
</style>
