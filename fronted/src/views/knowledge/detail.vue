<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  getKnowledgeBase,
  getDocuments,
  removeDocument,
  uploadDocument,
  type DocumentItem,
} from "@/api/knowledge";
import { MessagePlugin } from "tdesign-vue-next";
import type { UploadFile } from "tdesign-vue-next";

const route = useRoute();
const router = useRouter();
const kbId = computed(() => route.params.kbId as string);

// ===========================================================================
// 知识库信息
// ===========================================================================

interface KBInfo {
  id: string;
  name: string;
  description: string | null;
  embeddingModel: string;
  embeddingDimension: number;
  documentCount: number;
  chunkCount: number;
  workspaceId: string;
  updatedAt: string;
}
const kbInfo = ref<KBInfo | null>(null);
const kbLoading = ref(false);

const loadKBInfo = async () => {
  kbLoading.value = true;
  try {
    kbInfo.value = await getKnowledgeBase(kbId.value);
  } catch {
    MessagePlugin.error("知识库加载失败，可能已被删除");
    router.replace({ path: "/knowledge" });
  } finally {
    kbLoading.value = false;
  }
};

// ===========================================================================
// 文档列表
// ===========================================================================

const documents = ref<DocumentItem[]>([]);
const docLoading = ref(false);
let pollingTimer: number | null = null;

const loadDocuments = async () => {
  docLoading.value = true;
  try {
    documents.value = await getDocuments(kbId.value);
  } catch {
    // 静默
  } finally {
    docLoading.value = false;
  }
};

/** 启动状态轮询：有 UPLOADED/PROCESSING 状态的文档时每 2s 刷新 */
const startPolling = () => {
  stopPolling();
  pollingTimer = window.setInterval(() => {
    const hasProcessing = documents.value.some(
      (d) => d.status === "UPLOADED" || d.status === "PROCESSING",
    );
    if (!hasProcessing) {
      stopPolling();
      return;
    }
    loadDocuments();
  }, 10000);
};

const stopPolling = () => {
  if (pollingTimer !== null) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
};

// ===========================================================================
// 文件上传
// ===========================================================================

const uploadDialogVisible = ref(false);
const uploading = ref(false);
const fileList = ref<File[]>([]);

const openUploadDialog = () => {
  fileList.value = [];
  uploadDialogVisible.value = true;
};

const handlePickFiles = (e: Event) => {
  const input = e.target as HTMLInputElement;
  if (input.files) {
    fileList.value = Array.from(input.files);
  }
};

const submitUpload = async () => {
  if (fileList.value.length === 0) return;
  uploading.value = true;

  let success = 0;
  let failed = 0;

  for (const file of fileList.value) {
    try {
      await uploadDocument(kbId.value, file);
      success++;
    } catch (err) {
      failed++;
      console.error("Upload failed:", file.name, err);
    }
  }

  uploading.value = false;
  uploadDialogVisible.value = false;

  if (success > 0) {
    MessagePlugin.success(`${success} 个文件上传成功${failed > 0 ? `，${failed} 个失败` : ""}`);
    await loadDocuments();
    await loadKBInfo();
    startPolling();
  } else {
    MessagePlugin.error("全部文件上传失败，请检查后端服务");
  }
};

const allowedExts = [".pdf", ".docx", ".txt", ".md", ".markdown"];
const maxSizeMB = 50;
const fileAccept = allowedExts.join(",");

// ===========================================================================
// 删除文档
// ===========================================================================

const deleteTarget = ref<DocumentItem | null>(null);
const deleteDialogVisible = ref(false);
const deleting = ref(false);

const openDeleteDialog = (doc: DocumentItem) => {
  deleteTarget.value = doc;
  deleteDialogVisible.value = true;
};

const submitDelete = async () => {
  if (!deleteTarget.value) return;
  deleting.value = true;
  try {
    await removeDocument(deleteTarget.value.id);
    deleteDialogVisible.value = false;
    MessagePlugin.success("文档已删除");
    await loadDocuments();
    await loadKBInfo();
  } catch {
    MessagePlugin.error("删除失败，请稍后重试");
  } finally {
    deleting.value = false;
  }
};

// ===========================================================================
// 工具方法
// ===========================================================================

const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

const formatDate = (dateStr: string) => {
  return new Date(dateStr).toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
};

const statusMap: Record<string, { text: string; theme: "default" | "primary" | "success" | "warning" | "danger" }> = {
  UPLOADED: { text: "已上传", theme: "default" },
  PROCESSING: { text: "处理中", theme: "primary" },
  COMPLETED: { text: "已完成", theme: "success" },
  FAILED: { text: "处理失败", theme: "danger" },
};

const fileIcon = (fileType: string) => {
  const map: Record<string, string> = {
    PDF: "📕", DOCX: "📘", TXT: "📄", MARKDOWN: "📝",
  };
  return map[fileType] ?? "📄";
};

// ===========================================================================
// 生命周期
// ===========================================================================

onMounted(async () => {
  await Promise.all([loadKBInfo(), loadDocuments()]);
  startPolling();
});

onBeforeUnmount(() => {
  stopPolling();
});
</script>

<template>
  <div class="kb-detail-page">
    <!-- 头部面包屑 + 返回 -->
    <div class="page-header">
      <t-button variant="text" @click="router.push('/knowledge')">
        <template #icon><t-icon name="chevron-left" /></template>
        返回知识库列表
      </t-button>
      <div v-if="kbInfo" class="breadcrumb">
        <span class="sep">/</span>
        <span class="bc-label">知识库</span>
        <span class="sep">/</span>
        <span class="bc-name">{{ kbInfo.name }}</span>
      </div>
    </div>

    <t-loading :loading="kbLoading || docLoading" text="加载中..." :delay="200">
      <template v-if="kbInfo">
        <!-- 知识库概览卡片 -->
        <div class="kb-overview">
          <div class="kb-title-row">
            <span class="kb-icon-wrapper"><t-icon name="library" /></span>
            <div>
              <div class="kb-name">{{ kbInfo.name }}</div>
              <div class="kb-desc">{{ kbInfo.description || '暂无描述' }}</div>
            </div>
          </div>

          <div class="kb-stats">
            <div class="stat-card">
              <div class="stat-num">{{ kbInfo.documentCount }}</div>
              <div class="stat-label">文档</div>
            </div>
            <div class="stat-card">
              <div class="stat-num">{{ kbInfo.chunkCount }}</div>
              <div class="stat-label">分块</div>
            </div>
            <div class="stat-card">
              <div class="stat-num">{{ kbInfo.embeddingModel }}</div>
              <div class="stat-label">Embedding 模型</div>
            </div>
            <div class="stat-card">
              <div class="stat-num">{{ kbInfo.embeddingDimension }}</div>
              <div class="stat-label">向量维度</div>
            </div>
          </div>
        </div>

        <!-- 操作栏 + 文档列表 -->
        <div class="doc-section">
          <div class="doc-toolbar">
            <span class="section-title">文档列表 ({{ documents.length }})</span>
            <t-button theme="primary" @click="openUploadDialog">
              <template #icon><t-icon name="upload" /></template>
              上传文档
            </t-button>
          </div>

          <!-- 空状态 -->
          <t-empty v-if="documents.length === 0" type="default" title="还没有文档"
            description="上传 PDF / Word / TXT / Markdown 文件，系统将自动解析并向量化">
            <template #action>
              <t-button theme="primary" @click="openUploadDialog">上传第一个文档</t-button>
            </template>
          </t-empty>

          <!-- 文档表格 -->
          <t-table v-else :data="documents" row-key="id" hover stripe size="medium">
            <template #columns>
              <t-table-col col-key="fileName" title="文件名" :cell-width="280">
                <template #cell="{ row }">
                  <div class="file-name-cell">
                    <span class="file-icon">{{ fileIcon(row.fileType) }}</span>
                    <div class="file-info">
                      <div class="file-name" :title="row.fileName">{{ row.fileName }}</div>
                      <div class="file-meta">{{ row.fileType }} · {{ formatSize(row.fileSize) }}</div>
                    </div>
                  </div>
                </template>
              </t-table-col>

              <t-table-col col-key="status" title="状态" :cell-width="120">
                <template #cell="{ row }">
                  <t-tag :theme="statusMap[row.status].theme" variant="light" size="small">
                    {{ statusMap[row.status].text }}
                  </t-tag>
                  <t-progress v-if="row.status === 'PROCESSING'" :percentage="60" :bar-height="3"
                    class="inline-progress" />
                </template>
              </t-table-col>

              <t-table-col col-key="pageCount" title="页数" :cell-width="80">
                <template #cell="{ row }">{{ row.pageCount ?? '-' }}</template>
              </t-table-col>

              <t-table-col col-key="errorMessage" title="错误信息">
                <template #cell="{ row }">
                  <span v-if="row.status === 'FAILED' && row.errorMessage" class="error-text" :title="row.errorMessage">
                    {{ row.errorMessage }}
                  </span>
                  <span v-else class="placeholder">-</span>
                </template>
              </t-table-col>

              <t-table-col col-key="createdAt" title="上传时间" :cell-width="180">
                <template #cell="{ row }">{{ formatDate(row.createdAt) }}</template>
              </t-table-col>

              <t-table-col col-key="actions" title="操作" :cell-width="120" :align="'right'">
                <template #cell="{ row }">
                  <t-button variant="text" size="small" status="danger" @click="openDeleteDialog(row)">
                    <template #icon><t-icon name="delete" /></template>
                    删除
                  </t-button>
                </template>
              </t-table-col>
            </template>
          </t-table>

          <div v-if="documents.some(d => d.status === 'UPLOADED' || d.status === 'PROCESSING')" class="processing-tip">
            <t-icon name="time" />
            文档正在后台解析中，页面将自动刷新状态...
          </div>
        </div>
      </template>
    </t-loading>

    <!-- 上传对话框 -->
    <t-dialog v-model:visible="uploadDialogVisible" header="上传文档" :footer="false" width="520px">
      <div class="upload-area">
        <label class="upload-dropzone" for="kb-file-input">
          <input id="kb-file-input" type="file" :accept="fileAccept" multiple hidden @change="handlePickFiles" />
          <div class="dz-icon">📄</div>
          <div class="dz-title">点击选择文件，或拖拽到此处</div>
          <div class="dz-desc">
            支持 {{ allowedExts.join(' / ') }}，单文件最大 {{ maxSizeMB }}MB
          </div>
        </label>

        <div v-if="fileList.length > 0" class="file-list-preview">
          <div class="preview-title">已选 {{ fileList.length }} 个文件：</div>
          <div v-for="(f, i) in fileList" :key="i" class="preview-item">
            <span class="preview-icon">📄</span>
            <span class="preview-name">{{ f.name }}</span>
            <span class="preview-size">{{ formatSize(f.size) }}</span>
          </div>
        </div>
      </div>

      <div class="dialog-actions">
        <t-button variant="outline" type="button" @click="uploadDialogVisible = false">取消</t-button>
        <t-button theme="primary" :loading="uploading" :disabled="fileList.length === 0" @click="submitUpload">
          {{ uploading ? "上传中..." : `上传 ${fileList.length} 个文件` }}
        </t-button>
      </div>
    </t-dialog>

    <!-- 删除确认 -->
    <t-dialog v-model:visible="deleteDialogVisible" header="删除文档" :footer="false" width="420px">
      <p class="delete-tip">
        确定要删除文档「{{ deleteTarget?.fileName }}」吗？
        <br />删除后其关联的向量分块将一并清理。
      </p>
      <div class="dialog-actions">
        <t-button variant="outline" type="button" @click="deleteDialogVisible = false">取消</t-button>
        <t-button theme="danger" :loading="deleting" @click="submitDelete">确认删除</t-button>
      </div>
    </t-dialog>
  </div>
</template>

<style scoped lang="less">
.kb-detail-page {
  padding: var(--space-4) var(--space-8) var(--space-8);
  min-height: 100%;
  box-sizing: border-box;
}

.page-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) 0 var(--space-4);

  .breadcrumb {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--font-sm);

    .sep {
      color: var(--color-text-tertiary);
    }

    .bc-label {
      color: var(--color-text-tertiary);
    }

    .bc-name {
      color: var(--color-text);
      font-weight: 500;
    }
  }
}

// 概览卡片
.kb-overview {
  background: var(--color-bg-white);
  border-radius: var(--radius-lg);
  padding: var(--space-6);
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-5);

  .kb-title-row {
    display: flex;
    align-items: center;
    gap: var(--space-4);

    .kb-icon-wrapper {
      width: 48px;
      height: 48px;
      border-radius: var(--radius-lg);
      background: var(--primary-bg);
      color: var(--primary);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
    }

    .kb-name {
      font-size: var(--font-xl);
      font-weight: 600;
      color: var(--color-text);
    }

    .kb-desc {
      font-size: var(--font-sm);
      color: var(--color-text-tertiary);
      margin-top: 2px;
    }
  }

  .kb-stats {
    display: flex;
    gap: var(--space-6);

    .stat-card {
      text-align: center;
      padding: 0 var(--space-4);
      border-left: 1px solid var(--color-border);

      &:first-child {
        border-left: none;
      }

      .stat-num {
        font-size: var(--font-lg);
        font-weight: 600;
        color: var(--color-text);
      }

      .stat-label {
        font-size: 12px;
        color: var(--color-text-tertiary);
        margin-top: 2px;
      }
    }
  }
}

// 文档区域
.doc-section {
  background: var(--color-bg-white);
  border-radius: var(--radius-lg);
  padding: var(--space-5);

  .doc-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--space-4);

    .section-title {
      font-size: var(--font-md);
      font-weight: 600;
      color: var(--color-text);
    }
  }
}

.file-name-cell {
  display: flex;
  align-items: center;
  gap: var(--space-3);

  .file-icon {
    font-size: 20px;
  }

  .file-info {
    display: flex;
    flex-direction: column;
    gap: 2px;

    .file-name {
      font-size: var(--font-sm);
      font-weight: 500;
      color: var(--color-text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 240px;
    }

    .file-meta {
      font-size: 11px;
      color: var(--color-text-tertiary);
    }
  }
}

.inline-progress {
  width: 80px;
  margin-left: 6px;
  display: inline-block;
}

.error-text {
  color: var(--color-error);
  font-size: 12px;
  max-width: 200px;
  display: inline-block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.placeholder {
  color: var(--color-text-tertiary);
}

.processing-tip {
  margin-top: var(--space-4);
  padding: var(--space-2) var(--space-4);
  background: var(--primary-bg);
  border-radius: var(--radius-md);
  font-size: var(--font-sm);
  color: var(--primary);
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

// 上传区域
.upload-area {
  .upload-dropzone {
    display: block;
    border: 2px dashed var(--color-border-dashed);
    border-radius: var(--radius-lg);
    padding: var(--space-8);
    text-align: center;
    cursor: pointer;
    transition: border-color 0.2s ease;

    &:hover {
      border-color: var(--primary);
      background: var(--primary-bg);
    }

    .dz-icon {
      font-size: 40px;
      margin-bottom: var(--space-3);
    }

    .dz-title {
      font-size: var(--font-base);
      font-weight: 500;
      color: var(--color-text);
    }

    .dz-desc {
      font-size: var(--font-sm);
      color: var(--color-text-tertiary);
      margin-top: 4px;
    }
  }

  .file-list-preview {
    margin-top: var(--space-4);
    max-height: 180px;
    overflow-y: auto;
    background: var(--color-bg-light);
    border-radius: var(--radius-md);
    padding: var(--space-3);

    .preview-title {
      font-size: var(--font-sm);
      font-weight: 500;
      color: var(--color-text);
      margin-bottom: var(--space-2);
    }

    .preview-item {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: 4px 0;
      font-size: var(--font-sm);

      .preview-icon {
        font-size: 14px;
      }

      .preview-name {
        flex: 1;
        color: var(--color-text);
      }

      .preview-size {
        color: var(--color-text-tertiary);
      }
    }
  }
}

.delete-tip {
  font-size: var(--font-base);
  line-height: 1.6;
  color: var(--color-text);
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-4);
}
</style>
