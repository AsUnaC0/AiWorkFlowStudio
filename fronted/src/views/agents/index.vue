<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import {
  listAgents,
  createAgent,
  deleteAgent,
  type Agent,
} from "@/api/agent";
import { AGENT_TEMPLATES, type AgentType } from "@/types/agent";
import { MessagePlugin, DialogPlugin } from "tdesign-vue-next";
import { useUserStore } from "@/stores/user";

const router = useRouter();
const userStore = useUserStore();

const agents = ref<Agent[]>([]);
const loading = ref(false);

const loadAgents = async () => {
  loading.value = true;
  try {
    agents.value = await listAgents();
  } catch {
    MessagePlugin.error("加载 Agent 列表失败");
  } finally {
    loading.value = false;
  }
};

onMounted(loadAgents);

const getTemplate = (type: AgentType) =>
  AGENT_TEMPLATES.find((t) => t.type === type);

const handleDelete = async (agent: Agent) => {
  if (agent.isSystem) {
    MessagePlugin.warning("系统预设 Agent 不可删除");
    return;
  }
  if (agent.isDefault) {
    MessagePlugin.warning("默认 Agent 不能删除");
    return;
  }

  const confirm = DialogPlugin.confirm({
    header: "确认删除",
    body: `确定要删除 Agent「${agent.name}」吗？该 Agent 下的所有会话也会被删除。`,
    confirmBtn: { content: "删除", theme: "danger" },
    cancelBtn: { content: "取消" },
    onConfirm: async () => {
      try {
        await deleteAgent(agent.id);
        confirm.destroy();
        MessagePlugin.success("Agent 已删除");
        loadAgents();
      } catch (err) {
        MessagePlugin.error("删除失败");
      }
    },
    onClose: () => confirm.destroy(),
  });
};

const openCreateDialog = () => {
  creating.value = { name: "", type: "CUSTOM", description: "" };
  showCreateDialog.value = true;
};

const handleCreate = async () => {
  const { name, type, description } = creating.value;
  if (!name.trim()) {
    MessagePlugin.warning("请输入 Agent 名称");
    return;
  }

  creatingLoading.value = true;
  try {
    const agent = await createAgent({
      name: name.trim(),
      type,
      description: description.trim() || undefined,
    });
    showCreateDialog.value = false;
    MessagePlugin.success("Agent 创建成功");
    router.push(`/agents/${agent.id}`);
  } catch {
    MessagePlugin.error("创建 Agent 失败");
  } finally {
    creatingLoading.value = false;
  }
};

const goChat = (agentId: string) => {
  router.push(`/chat?agent=${agentId}`);
};

const goDetail = (agentId: string) => {
  router.push(`/agents/${agentId}`);
};
</script>

<template>
  <div class="agents-page">
    <!-- 顶部 -->
    <header class="page-header">
      <div class="header-left">
        <h1 class="page-title">Agent 管理</h1>
        <p class="page-subtitle">创建和管理你的 AI Agent，每个 Agent 可以独立配置模型、知识库、工作流和工具。</p>
      </div>
      <button class="create-btn" @click="openCreateDialog">
        <t-icon name="add" />
        <span>创建 Agent</span>
      </button>
    </header>

    <!-- 统一 Agent 列表 -->
    <div v-if="agents.length === 0 && !loading" class="empty-state">
      <t-icon name="chat" class="empty-icon" />
      <p>还没有任何 Agent，先创建一个吧</p>
      <button class="create-btn large" @click="openCreateDialog">
        <t-icon name="add" />
        创建第一个 Agent
      </button>
    </div>

    <div v-else class="agent-grid">
      <div v-for="agent in agents" :key="agent.id" class="agent-card" :class="{ system: agent.isSystem }">
        <div class="card-header">
          <div class="card-avatar" :class="agent.type.toLowerCase()">
            <t-icon :name="agent.isSystem ? 'tool' : getTemplate(agent.type)?.icon ?? 'chat'" />
          </div>
          <div class="card-badges">
            <t-tag v-if="agent.isSystem" theme="warning" variant="light" size="small">
              系统预设
            </t-tag>
            <t-tag v-else theme="default" variant="light" size="small">
              自建
            </t-tag>
            <t-tag v-if="agent.isDefault && !agent.isSystem" theme="primary" variant="light" size="small">
              默认
            </t-tag>
          </div>
        </div>

        <h3 class="card-title">{{ agent.name }}</h3>
        <p class="card-desc">{{ agent.description || agent.type.toLowerCase() }}</p>

        <div class="card-config">
          <span class="config-chip">
            <t-icon name="server" />
            {{ agent.model }}
          </span>
          <span v-if="agent.workflowIds.length > 0" class="config-chip">
            <t-icon name="flow" />
            {{ agent.workflowIds.length }} WF
          </span>
          <span v-if="agent.knowledgeBaseIds.length > 0" class="config-chip">
            <t-icon name="library" />
            {{ agent.knowledgeBaseIds.length }} KB
          </span>
        </div>

        <div class="card-actions">
          <button class="action-btn primary" @click="goChat(agent.id)">
            <t-icon name="chat" />
            对话
          </button>
          <button class="action-btn" @click="goDetail(agent.id)">
            <t-icon name="setting" />
            配置
          </button>
          <button v-if="!agent.isSystem" class="action-btn danger" @click="handleDelete(agent)">
            <t-icon name="delete" />
          </button>
        </div>
      </div>
    </div>

    <!-- 创建对话框 -->
    <t-dialog v-if="showCreateDialog" header="创建 Agent" :footer="false" :width="520" @close="showCreateDialog = false">
      <div class="create-form">
        <div class="form-item">
          <label>选择类型</label>
          <div class="template-grid">
            <button v-for="tpl in AGENT_TEMPLATES" :key="tpl.type" class="template-card"
              :class="{ active: creating.type === tpl.type }" @click="creating.type = tpl.type">
              <t-icon :name="tpl.icon" class="tpl-icon" />
              <div class="tpl-info">
                <span class="tpl-label">{{ tpl.label }}</span>
                <span class="tpl-desc">{{ tpl.description }}</span>
              </div>
            </button>
          </div>
        </div>

        <div class="form-item">
          <label>Agent 名称</label>
          <input v-model="creating.name" type="text" class="form-input"
            :placeholder="getTemplate(creating.type)?.defaultName" maxlength="50" />
        </div>

        <div class="form-item">
          <label>描述（可选）</label>
          <textarea v-model="creating.description" class="form-textarea" placeholder="帮助我分析销售数据并生成结论。" rows="2"
            maxlength="200" />
        </div>

        <div class="form-actions">
          <t-button theme="default" @click="showCreateDialog = false">
            取消
          </t-button>
          <t-button theme="primary" :loading="creatingLoading" @click="handleCreate">
            创建并配置
          </t-button>
        </div>
      </div>
    </t-dialog>
  </div>
</template>

<style scoped lang="less">
@import "../../styles/variables.less";

.agents-page {
  padding: @space-8 @space-12;
  max-width: 1200px;
  margin: 0 auto;
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: @space-8;

  .page-title {
    font-size: 28px;
    font-weight: 700;
    margin: 0 0 @space-2;
  }

  .page-subtitle {
    font-size: @font-base;
    color: @color-text-secondary;
    margin: 0;
    max-width: 560px;
  }
}

.create-btn {
  display: inline-flex;
  align-items: center;
  gap: @space-2;
  padding: @space-3 @space-5;
  background: @primary;
  color: #fff;
  border: none;
  border-radius: @radius-lg;
  font-size: @font-sm;
  font-weight: 600;
  cursor: pointer;
  transition: all @duration-fast;

  &:hover {
    background: @primary-hover;
  }

  &.large {
    padding: @space-4 @space-6;
    font-size: @font-base;
    margin-top: @space-4;
  }
}

.section {
  margin-bottom: @space-10;

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: @space-4;

    .section-title {
      display: inline-flex;
      align-items: center;
      gap: @space-2;
      font-size: @font-sm;
      font-weight: 600;
      color: @color-text-secondary;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }

    .section-badge {
      font-size: 11px;
      color: @color-text-tertiary;
      padding: 2px 8px;
      background: @color-bg-hover;
      border-radius: @radius-pill;
    }

    .section-action {
      padding: 4px 8px;
      border: none;
      background: transparent;
      color: @color-text-tertiary;
      cursor: pointer;
      border-radius: @radius-md;

      &:hover {
        background: @color-bg-hover;
        color: @primary;
      }
    }
  }
}

.agent-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: @space-4;
}

.agent-card {
  background: @color-bg-surface;
  border: 1px solid @color-border;
  border-radius: @radius-lg;
  padding: @space-5;
  display: flex;
  flex-direction: column;
  gap: @space-3;
  transition: all @duration-fast;

  &:hover {
    border-color: @primary;
    box-shadow: @shadow-card;
    transform: translateY(-2px);
  }

  &.system {
    background: linear-gradient(135deg, rgba(249, 115, 22, 0.04) 0%, transparent 100%);
    border-color: rgba(249, 115, 22, 0.2);
  }

  .card-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
  }

  .card-avatar {
    width: 44px;
    height: 44px;
    border-radius: @radius-lg;
    background: @color-bg-hover;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 22px;

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
  }

  .card-badges {
    display: flex;
    gap: 4px;
  }

  .card-title {
    font-size: @font-base;
    font-weight: 600;
    margin: 0;
    color: @color-text;
  }

  .card-desc {
    font-size: @font-sm;
    color: @color-text-tertiary;
    margin: 0;
    line-height: 1.5;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    min-height: 36px;
  }

  .card-config {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;

    .config-chip {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 2px 8px;
      background: @color-bg-hover;
      border-radius: @radius-pill;
      font-size: 11px;
      color: @color-text-tertiary;
    }
  }

  .card-actions {
    display: flex;
    gap: @space-2;
    padding-top: @space-2;
    border-top: 1px solid @color-border;
    margin-top: auto;
  }
}

.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  background: transparent;
  border: 1px solid @color-border;
  border-radius: @radius-md;
  font-size: 12px;
  color: @color-text-secondary;
  cursor: pointer;
  transition: all @duration-fast;

  &:hover {
    background: @color-bg-hover;
    color: @color-text;
  }

  &.primary {
    background: @primary;
    color: #fff;
    border-color: @primary;

    &:hover {
      background: @primary-hover;
    }
  }

  &.danger {
    border-color: transparent;
    color: @color-text-tertiary;
    padding: 6px 8px;

    &:hover {
      background: rgba(239, 68, 68, 0.08);
      color: #ef4444;
    }
  }
}

.empty-state {
  text-align: center;
  padding: @space-12;
  color: @color-text-tertiary;

  .empty-icon {
    font-size: 48px;
    margin-bottom: @space-4;
    display: block;
  }

  p {
    font-size: @font-base;
    margin: 0;
  }
}

// Create form
.create-form {
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

    .tpl-icon {
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
