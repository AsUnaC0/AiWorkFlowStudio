<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, nextTick } from "vue";
import { getModels, chat as chatApi, type AiModel } from "@/api/ai";
import { getKnowledgeBases, type KnowledgeBase } from "@/api/knowledge";
import { useClickOutside } from "@/composables/useClickOutside";
import { MessagePlugin } from "tdesign-vue-next";

// ===========================================================================
// 状态
// ===========================================================================

const models = ref<AiModel[]>([]);
const selectedModel = ref("");
const modelsLoading = ref(false);

const knowledgeOptions = ref<KnowledgeBase[]>([]);
const kbLoading = ref(false);
const selectedKnowledgeIds = ref<string[]>([]);

const inputText = ref("");
const sending = ref(false);
const inputRef = ref<HTMLTextAreaElement | null>(null);

// 聊天历史
interface ChatItem {
  role: "user" | "assistant";
  content: string;
  time: string;
}
const messages = ref<ChatItem[]>([]);
const chatContainerRef = ref<HTMLElement | null>(null);

// 快捷操作
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

const loadKnowledge = async () => {
  kbLoading.value = true;
  try {
    knowledgeOptions.value = await getKnowledgeBases().catch(() => []);
  } finally {
    kbLoading.value = false;
  }
};

onMounted(() => {
  loadModels();
  loadKnowledge();
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

const appendMessage = (role: "user" | "assistant", content: string) => {
  messages.value.push({
    role,
    content,
    time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
  });
};

const scrollToBottom = async () => {
  await nextTick();
  if (chatContainerRef.value) {
    chatContainerRef.value.scrollTo({
      top: chatContainerRef.value.scrollHeight,
      behavior: "smooth",
    });
  }
};

const send = async () => {
  if (!canSend.value) return;

  const userText = inputText.value.trim();
  inputText.value = "";
  appendMessage("user", userText);
  sending.value = true;
  scrollToBottom();

  try {
    const history = messages.value
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
};

// 模型下拉控制
const showModelDropdown = ref(false);
const showKbDropdown = ref(false);
const modelChipRef = ref<HTMLElement | null>(null);
const modelChipRefChat = ref<HTMLElement | null>(null);
const kbChipRef = ref<HTMLElement | null>(null);
const kbChipRefChat = ref<HTMLElement | null>(null);

// 点击外部关闭 chips 下拉（两组 ref 分别对应空状态和有对话状态）
useClickOutside([modelChipRef, modelChipRefChat], () => {
  showModelDropdown.value = false;
});
useClickOutside([kbChipRef, kbChipRefChat], () => {
  showKbDropdown.value = false;
});

// 切换知识库选中（提取出来避免 inline const）
const toggleKnowledgeBase = (kbId: string) => {
  const idx = selectedKnowledgeIds.value.indexOf(kbId);
  if (idx > -1) {
    selectedKnowledgeIds.value.splice(idx, 1);
  } else {
    selectedKnowledgeIds.value.push(kbId);
  }
};

const hasKnowledgeSelected = computed(() => selectedKnowledgeIds.value.length > 0);
</script>

<template>
  <div class="chat-page">
    <!-- 空状态：Hero 居中布局 -->
    <template v-if="isEmpty">
      <div class="hero-section">
        <div class="hero-content">
          <!-- Logo -->
          <div class="hero-logo">✦</div>

          <!-- 标题 -->
          <h1 class="hero-title">How can I help you?</h1>
          <p class="hero-subtitle">
            Build, run and connect AI workflows. Ask anything about your knowledge base.
          </p>

          <!-- 主输入框 -->
          <div class="prompt-box">
            <div class="prompt-textarea">
              <textarea ref="inputRef" v-model="inputText" placeholder="Ask anything..." :disabled="sending" rows="1"
                @keydown="onKeydown" />
              <!-- 发送按钮 -->
              <button class="send-btn" :class="{ active: canSend }" :disabled="!canSend" @click="send">
                <t-icon :name="sending ? 'loading' : 'send'" :spin="sending" />
              </button>
            </div>

            <!-- 输入框底部 chips -->
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
                  <span>{{ hasKnowledgeSelected ? `${selectedKnowledgeIds.length} Knowledge` : 'Knowledge' }}</span>
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
                    <div v-if="knowledgeOptions.length === 0" class="dropdown-empty">
                      暂无知识库
                    </div>
                  </div>
                </transition>
              </div>

              <!-- 快捷操作分隔 -->
              <div class="chip-divider" />

              <!-- 清空按钮 -->
              <button v-if="hasKnowledgeSelected || selectedModel" class="action-chip clear"
                @click="selectedKnowledgeIds = []">
                <t-icon name="close" />
                <span>Clear</span>
              </button>
            </div>
          </div>

          <!-- Suggestion cards -->
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
        <!-- 消息区 -->
        <div ref="chatContainerRef" class="chat-messages">
          <div v-for="(msg, idx) in messages" :key="idx" class="message-item" :class="msg.role">
            <div class="message-avatar">
              <template v-if="msg.role === 'user'">👤</template>
              <template v-else>✦</template>
            </div>
            <div class="message-body">
              <div class="message-meta">
                <span class="message-role">{{ msg.role === 'user' ? 'You' : 'AI' }}</span>
                <span class="message-time">{{ msg.time }}</span>
              </div>
              <div class="message-content">{{ msg.content }}</div>
            </div>
          </div>

          <!-- 发送中指示器 -->
          <div v-if="sending" class="message-item assistant">
            <div class="message-avatar">✦</div>
            <div class="message-body">
              <div class="message-content typing">
                <span></span><span></span><span></span>
              </div>
            </div>
          </div>
        </div>

        <!-- 底部输入区 -->
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

/* ============================================================
 * Hero (空状态)
 * ============================================================ */
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

/* Prompt Box */
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

/* Action Chips */
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

/* Chip Dropdowns */
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

/* Suggestion Cards */
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

/* ============================================================
 * 聊天布局（有对话后）
 * ============================================================ */
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

/* 底部输入区 */
.chat-input-bottom {
  padding: @space-4 @space-12 @space-8;
  max-width: 800px;
  margin: 0 auto;
  width: 100%;
}
</style>
