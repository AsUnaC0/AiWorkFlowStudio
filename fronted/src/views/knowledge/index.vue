<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import {
  createKnowledgeBase,
  getKnowledgeBases,
  removeKnowledgeBase,
} from "@/api/knowledge";
import { MessagePlugin } from "tdesign-vue-next";
import type { KnowledgeBase } from "@/types/knowledge";

const router = useRouter();

// ========== 知识库列表 ==========
const knowledgeBases = ref<KnowledgeBase[]>([]);
const kbLoading = ref(false);
const kbError = ref("");

const fetchKnowledgeBases = async () => {
  kbLoading.value = true;
  kbError.value = "";
  try {
    knowledgeBases.value = await getKnowledgeBases();
  } catch {
    kbError.value = "知识库加载失败，请稍后重试";
  } finally {
    kbLoading.value = false;
  }
};

// 创建知识库
const createDialogVisible = ref(false);
const kbCreating = ref(false);
const createName = ref("");
const createDescription = ref("");
const createEmbeddingModel = ref("nomic-embed-text");
const createEmbeddingDimension = ref(768);
const createError = ref("");

const openCreateDialog = () => {
  createName.value = "";
  createDescription.value = "";
  createEmbeddingModel.value = "nomic-embed-text";
  createEmbeddingDimension.value = 768;
  createError.value = "";
  createDialogVisible.value = true;
};

const submitCreate = async () => {
  const name = createName.value.trim();
  if (!name) {
    createError.value = "请输入知识库名称";
    return;
  }
  if (!createEmbeddingModel.value.trim()) {
    createError.value = "请输入向量模型名称";
    return;
  }
  const dimension = Number(createEmbeddingDimension.value);
  if (!Number.isInteger(dimension) || dimension < 1 || dimension > 8192) {
    createError.value = "向量维度需为 1 - 8192 之间的整数";
    return;
  }

  kbCreating.value = true;
  createError.value = "";
  try {
    await createKnowledgeBase({
      name,
      description: createDescription.value.trim() || undefined,
      embeddingModel: createEmbeddingModel.value.trim(),
      embeddingDimension: dimension,
    });
    createDialogVisible.value = false;
    MessagePlugin.success("知识库创建成功");
    fetchKnowledgeBases();
  } catch {
    createError.value = "创建失败，请稍后重试";
  } finally {
    kbCreating.value = false;
  }
};

// 进入知识库详情页
const enterKnowledge = (kb: KnowledgeBase) => {
  router.push({ path: `/knowledge/${kb.id}` });
};

// 删除知识库
const deleteTarget = ref<KnowledgeBase | null>(null);
const deleteDialogVisible = ref(false);
const kbDeleting = ref(false);
const deleteError = ref("");

const openDeleteDialog = (kb: KnowledgeBase) => {
  deleteTarget.value = kb;
  deleteError.value = "";
  deleteDialogVisible.value = true;
};

const submitDelete = async () => {
  if (!deleteTarget.value) return;
  kbDeleting.value = true;
  deleteError.value = "";
  try {
    await removeKnowledgeBase(deleteTarget.value.id);
    deleteDialogVisible.value = false;
    MessagePlugin.success("知识库已删除");
    fetchKnowledgeBases();
  } catch {
    deleteError.value = "删除失败，请稍后重试";
  } finally {
    kbDeleting.value = false;
  }
};

// 相对时间
const formatRelativeTime = (dateStr: string) => {
  const date = new Date(dateStr);
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

onMounted(() => {
  fetchKnowledgeBases();
});
</script>

<template>
  <div class="page-container">
    <!-- 页面头部 -->
    <div class="page-header">
      <div class="page-header-info">
        <h1 class="page-title">Knowledge</h1>
        <p class="page-subtitle">
          Your knowledge bases. Connect documents and make your AI smarter.
        </p>
      </div>
      <div class="page-header-actions">
        <t-button theme="primary" @click="openCreateDialog">
          <template #icon><t-icon name="add" /></template>
          New Knowledge Base
        </t-button>
      </div>
    </div>

    <!-- 内容 -->
    <t-loading :loading="kbLoading" text="Loading..." :delay="200">
      <t-alert v-if="kbError" theme="error" :message="kbError" style="margin-top: var(--space-4)" />

      <!-- 知识库列表 -->
      <template v-else-if="knowledgeBases.length > 0">
        <div class="kb-list">
          <div
            v-for="kb in knowledgeBases"
            :key="kb.id"
            class="kb-row"
            @click="enterKnowledge(kb)"
          >
            <!-- 图标 -->
            <div class="kb-icon">
              <t-icon name="library" />
            </div>

            <!-- 主信息 -->
            <div class="kb-main">
              <div class="kb-name">{{ kb.name }}</div>
              <div class="kb-desc">
                {{ kb.description || 'No description' }}
              </div>
            </div>

            <!-- 统计 -->
            <div class="kb-stats">
              <div class="stat">
                <span class="stat-value">{{ kb.documentCount }}</span>
                <span class="stat-label">Documents</span>
              </div>
              <div class="stat">
                <span class="stat-value">{{ kb.chunkCount }}</span>
                <span class="stat-label">Chunks</span>
              </div>
            </div>

            <!-- 状态 + 时间 -->
            <div class="kb-status">
              <span class="status-dot ready" />
              <span class="status-text">Ready</span>
              <span class="kb-updated">{{ formatRelativeTime(kb.updatedAt) }}</span>
            </div>

            <!-- 右侧操作 + 箭头 -->
            <div class="kb-row-actions">
              <t-dropdown @click.stop>
                <button class="row-more-btn" @click.stop>
                  <t-icon name="more" />
                </button>
                <template #dropdown>
                  <t-dropdown-menu>
                    <t-dropdown-item @click.stop="enterKnowledge(kb)">
                      <template #prefix><t-icon name="view-list" /></template>
                      Open
                    </t-dropdown-item>
                    <t-dropdown-item @click.stop="openDeleteDialog(kb)">
                      <template #prefix><t-icon name="delete" /></template>
                      Delete
                    </t-dropdown-item>
                  </t-dropdown-menu>
                </template>
              </t-dropdown>
              <t-icon name="chevron-right" class="row-arrow" />
            </div>
          </div>
        </div>
      </template>

      <!-- 空状态 -->
      <div v-else-if="!kbLoading && !kbError" class="empty-state">
        <div class="empty-icon">
          <t-icon name="library" />
        </div>
        <h3 class="empty-title">No knowledge bases yet</h3>
        <p class="empty-desc">
          Create your first knowledge base to power AI responses with your documents.
        </p>
        <t-button theme="primary" @click="openCreateDialog">
          <template #icon><t-icon name="add" /></template>
          Create Knowledge Base
        </t-button>
      </div>
    </t-loading>

    <!-- 创建知识库对话框 -->
    <t-dialog v-model:visible="createDialogVisible" header="Create Knowledge Base" :footer="false" width="480px">
      <t-form layout="vertical" @submit="submitCreate">
        <t-form-item label="Name">
          <t-input v-model="createName" placeholder="Product Documentation" maxlength="200" />
        </t-form-item>
        <t-form-item label="Description (optional)">
          <t-textarea v-model="createDescription" placeholder="A brief description of this knowledge base"
            :maxlength="1000" :autosize="{ minRows: 2, maxRows: 4 }" />
        </t-form-item>
        <t-form-item label="Embedding Model">
          <t-input v-model="createEmbeddingModel" placeholder="nomic-embed-text" maxlength="100" />
        </t-form-item>
        <t-form-item label="Embedding Dimension">
          <t-input-number v-model="createEmbeddingDimension" :min="1" :max="8192" :step="8" />
        </t-form-item>
        <t-alert v-if="createError" theme="error" :message="createError" class="form-alert" />
        <div class="dialog-actions">
          <t-button variant="outline" type="button" @click="createDialogVisible = false">
            Cancel
          </t-button>
          <t-button theme="primary" type="submit" :loading="kbCreating">
            Create
          </t-button>
        </div>
      </t-form>
    </t-dialog>

    <!-- 删除确认对话框 -->
    <t-dialog v-model:visible="deleteDialogVisible" header="Delete Knowledge Base" :footer="false" width="420px">
      <p class="delete-tip">
        Are you sure you want to delete "{{ deleteTarget?.name }}"? All documents and chunks will be permanently removed.
      </p>
      <t-alert v-if="deleteError" theme="error" :message="deleteError" class="form-alert" />
      <div class="dialog-actions">
        <t-button variant="outline" type="button" @click="deleteDialogVisible = false">
          Cancel
        </t-button>
        <t-button theme="danger" type="button" :loading="kbDeleting" @click="submitDelete">
          Delete
        </t-button>
      </div>
    </t-dialog>
  </div>
</template>

<style scoped lang="less">
@import "../../styles/variables.less";

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: @space-8;
  animation: fade-slide-up @duration-normal @ease-out;

  .page-header-info {
    display: flex;
    flex-direction: column;
    gap: @space-1;
  }

  .page-title {
    font-size: @font-xxl;
    font-weight: 700;
    color: @color-text;
    letter-spacing: -0.01em;
    margin: 0;
  }

  .page-subtitle {
    font-size: @font-sm;
    color: @color-text-secondary;
    margin: 0;
  }
}

/* 列表行 */
.kb-list {
  display: flex;
  flex-direction: column;
  gap: @space-2;
}

.kb-row {
  display: flex;
  align-items: center;
  gap: @space-5;
  padding: @space-5 @space-6;
  background: @color-bg-surface;
  border: 1px solid @color-border;
  border-radius: @radius-lg;
  cursor: pointer;
  transition: all 180ms @ease-standard;
  animation: fade-slide-up @duration-normal @ease-out both;

  &:hover {
    border-color: @color-border-strong;
    box-shadow: @shadow-sm;

    .row-arrow {
      opacity: 1;
      transform: translateX(2px);
      color: @primary;
    }

    .kb-icon {
      background: @primary-light;
      color: @primary;
    }
  }

  .kb-icon {
    width: 44px;
    height: 44px;
    border-radius: @radius-md;
    background: @color-bg-hover;
    color: @color-text-secondary;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    flex-shrink: 0;
    transition: all 180ms @ease-standard;
  }

  .kb-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .kb-name {
    font-size: @font-md;
    font-weight: 600;
    color: @color-text;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .kb-desc {
    font-size: @font-sm;
    color: @color-text-secondary;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .kb-stats {
    display: flex;
    gap: @space-6;
    flex-shrink: 0;

    .stat {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 2px;

      .stat-value {
        font-size: @font-md;
        font-weight: 600;
        color: @color-text;
      }

      .stat-label {
        font-size: @font-xs;
        color: @color-text-tertiary;
      }
    }
  }

  .kb-status {
    display: flex;
    align-items: center;
    gap: @space-2;
    flex-shrink: 0;

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;

      &.ready {
        background: @color-success;
      }
    }

    .status-text {
      font-size: @font-xs;
      font-weight: 500;
      color: @color-success;
    }

    .kb-updated {
      font-size: @font-xs;
      color: @color-text-tertiary;
      margin-left: @space-2;
    }
  }

  .kb-row-actions {
    display: flex;
    align-items: center;
    gap: @space-1;
    flex-shrink: 0;

    .row-more-btn {
      width: 32px;
      height: 32px;
      border: none;
      background: transparent;
      border-radius: @radius-md;
      color: @color-text-tertiary;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transition: all @duration-fast;

      &:hover {
        background: @color-bg-hover;
        color: @color-text;
      }
    }

    .row-arrow {
      color: @color-text-tertiary;
      opacity: 0;
      transform: translateX(-2px);
      transition: all 180ms @ease-standard;
    }
  }

  &:hover .row-more-btn {
    opacity: 1;
  }
}

/* 空状态 */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: @space-16 @space-8;
  text-align: center;
  animation: fade-slide-up @duration-normal @ease-out;

  .empty-icon {
    width: 64px;
    height: 64px;
    border-radius: @radius-card;
    background: @color-bg-hover;
    color: @color-text-tertiary;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 28px;
    margin-bottom: @space-5;
  }

  .empty-title {
    font-size: @font-lg;
    font-weight: 600;
    color: @color-text;
    margin: 0 0 @space-2;
  }

  .empty-desc {
    font-size: @font-sm;
    color: @color-text-secondary;
    max-width: 360px;
    margin: 0 0 @space-6;
  }
}
</style>
