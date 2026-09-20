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
const createKnowledgeDialogVisible = ref(false);
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
  createKnowledgeDialogVisible.value = true;
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
    createKnowledgeDialogVisible.value = false;
    MessagePlugin.success("知识库创建成功");
    fetchKnowledgeBases();
  } catch {
    createError.value = "创建失败，请稍后重试";
  } finally {
    kbCreating.value = false;
  }
};

// 进入知识库详情页
const enterKnowledge = async (kb: { id: string }) => {
  await router.push({ path: `/knowledge/${kb.id}` });
};

// 事件处理：点击整个卡片进入详情
const handleKbClick = (e: MouseEvent) => {
  const target = e.currentTarget as HTMLElement;
  const id = target.dataset.id || "";
  const kb = knowledgeBases.value.find((k) => k.id === id);
  if (kb) enterKnowledge(kb);
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

const formatDate = (dateStr: string) => {
  const d = new Date(dateStr);
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

onMounted(() => {
  fetchKnowledgeBases();
});
</script>

<template>
  <div class="knowledge-page">
    <div class="page-toolbar">
      <span class="page-title">知识库</span>
      <div class="toolbar-actions">
        <t-button theme="primary" @click="openCreateDialog">
          <template #icon><t-icon name="add" /></template>
          创建知识库
        </t-button>
      </div>
    </div>

    <t-loading :loading="kbLoading" text="正在加载知识库..." :delay="200">
      <t-alert v-if="kbError" theme="error" :message="kbError" class="list-alert" />

      <template v-else-if="knowledgeBases.length > 0">
        <div class="kb-grid">
          <div v-for="kb in knowledgeBases" :key="kb.id" class="kb-card-wrapper" :data-id="kb.id"
            @click="handleKbClick">
            <t-card class="kb-card" :bordered="true">
              <template #header>
                <div class="kb-header">
                  <span class="kb-icon">
                    <t-icon name="library" />
                  </span>
                  <span class="kb-title">{{ kb.name }}</span>
                </div>
              </template>

              <div class="kb-body">
                <p v-if="kb.description" class="kb-desc">{{ kb.description }}</p>
                <p v-else class="kb-desc placeholder">暂无描述</p>

                <div class="kb-stats">
                  <div class="stat-item">
                    <span class="stat-value">{{ kb.documentCount }}</span>
                    <span class="stat-label">文档</span>
                  </div>
                  <div class="stat-item">
                    <span class="stat-value">{{ kb.chunkCount }}</span>
                    <span class="stat-label">分块</span>
                  </div>
                  <div class="stat-item">
                    <span class="stat-value">
                      {{ kb.embeddingModel }}<span class="dimension">@{{ kb.embeddingDimension }}</span>
                    </span>
                    <span class="stat-label">向量模型</span>
                  </div>
                </div>
              </div>

              <template #footer>
                <div class="kb-footer">
                  <div class="kb-meta">
                    <span>更新于 {{ formatDate(kb.updatedAt) }}</span>
                  </div>
                  <div class="kb-actions">
                    <t-button variant="text" size="small" @click.stop="enterKnowledge(kb)">
                      <template #icon><t-icon name="view-list" /></template>
                      进入管理
                    </t-button>
                    <t-button variant="text" size="small" status="danger" @click.stop="openDeleteDialog(kb)">
                      <template #icon><t-icon name="delete" /></template>
                      删除
                    </t-button>
                  </div>
                </div>
              </template>
            </t-card>
          </div>
        </div>
      </template>

      <t-empty v-else type="empty" title="还没有知识库" description="点击上方按钮创建第一个知识库吧">
        <template #action>
          <t-button theme="primary" @click="openCreateDialog">创建知识库</t-button>
        </template>
      </t-empty>
    </t-loading>

    <!-- 创建知识库对话框 -->
    <t-dialog v-model:visible="createKnowledgeDialogVisible" header="创建知识库" :footer="false" width="480px">
      <t-form layout="vertical" @submit="submitCreate">
        <t-form-item label="知识库名称">
          <t-input v-model="createName" placeholder="请输入知识库名称" maxlength="200" />
        </t-form-item>
        <t-form-item label="描述">
          <t-textarea v-model="createDescription" placeholder="请输入知识库描述（可选）" :maxlength="1000"
            :autosize="{ minRows: 2, maxRows: 4 }" />
        </t-form-item>
        <t-form-item label="向量模型">
          <t-input v-model="createEmbeddingModel" placeholder="如 nomic-embed-text" maxlength="100" />
        </t-form-item>
        <t-form-item label="向量维度">
          <t-input-number v-model="createEmbeddingDimension" :min="1" :max="8192" :step="8" placeholder="向量维度" />
        </t-form-item>
        <t-alert v-if="createError" theme="error" :message="createError" class="form-alert" />
        <div class="dialog-actions">
          <t-button variant="outline" type="button" @click="createKnowledgeDialogVisible = false">
            取消
          </t-button>
          <t-button theme="primary" type="submit" :loading="kbCreating">
            创建
          </t-button>
        </div>
      </t-form>
    </t-dialog>

    <!-- 删除知识库确认对话框 -->
    <t-dialog v-model:visible="deleteDialogVisible" header="删除知识库" :footer="false" width="420px">
      <p class="delete-tip">
        确定要删除知识库「{{ deleteTarget?.name }}」吗？删除后其中的文档数据将无法恢复。
      </p>
      <t-alert v-if="deleteError" theme="error" :message="deleteError" class="form-alert" />
      <div class="dialog-actions">
        <t-button variant="outline" type="button" @click="deleteDialogVisible = false">
          取消
        </t-button>
        <t-button theme="danger" type="button" :loading="kbDeleting" @click="submitDelete">
          确认删除
        </t-button>
      </div>
    </t-dialog>
  </div>
</template>

<style scoped lang="less">
.knowledge-page {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  padding: var(--space-4) var(--space-8) var(--space-8);
  box-sizing: border-box;
}

.page-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) 0 var(--space-4);
  flex-shrink: 0;

  .page-title {
    font-size: var(--font-xl);
    font-weight: 600;
    color: var(--color-text);
  }

  .toolbar-actions {
    display: flex;
    gap: var(--space-2);
  }
}

.list-alert {
  margin-top: var(--space-4);
}

.kb-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--space-4);
}

.kb-card-wrapper {
  transition: transform 0.2s ease;
  cursor: pointer;

  &:hover {
    transform: translateY(-2px);
  }
}

.kb-card {
  height: 100%;

  .kb-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);

    .kb-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border-radius: var(--radius-md);
      background: var(--primary-bg);
      color: var(--primary);
      font-size: var(--font-lg);
    }

    .kb-title {
      font-size: var(--font-lg);
      font-weight: 600;
      color: var(--color-text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }

  .kb-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-height: 96px;

    .kb-desc {
      margin: 0;
      font-size: var(--font-sm);
      color: var(--color-text);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;

      &.placeholder {
        color: var(--color-text-tertiary);
      }
    }

    .kb-stats {
      display: flex;
      gap: var(--space-5);
      margin-top: auto;

      .stat-item {
        display: flex;
        flex-direction: column;
        gap: 2px;

        .stat-value {
          font-weight: 600;
          color: var(--color-text);
          font-size: var(--font-base);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;

          .dimension {
            font-weight: 400;
            font-size: var(--font-xs);
            color: var(--color-text-tertiary);
          }
        }

        .stat-label {
          font-size: var(--font-xs);
          color: var(--color-text-tertiary);
        }
      }
    }
  }

  .kb-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);

    .kb-meta {
      font-size: var(--font-xs);
      color: var(--color-text-tertiary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .kb-actions {
      display: flex;
      align-items: center;
      gap: var(--space-1);
      flex-shrink: 0;
    }
  }
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.form-alert {
  margin-bottom: 4px;
}

.delete-tip {
  margin: 0;
  font-size: var(--font-base);
  color: var(--color-text);
  line-height: 1.6;
}
</style>
