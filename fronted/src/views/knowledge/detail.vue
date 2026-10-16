<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  getKnowledgeBase,
  getDocuments,
  removeDocument,
  uploadDocument,
  getEmbeddingVersions,
  createEmbeddingVersion,
  startReEmbed,
  activateEmbeddingVersion,
  removeEmbeddingVersion,
  type DocumentItem,
} from "@/api/knowledge";
import { getLlmModels, type LlmModel } from "@/api/provider";
import { MessagePlugin, DialogPlugin } from "tdesign-vue-next";

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
  embeddingLlmModelId: string | null;
  documentCount: number;
  chunkCount: number;
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
// 向量模型配置 / 重新向量化
//
// 切换模型不会直接改现有向量：建新版本 → 后台重新向量化 → 校验通过后手动激活，
// 旧版本保留可回滚，保证「配置里的模型」和「实际参与检索的向量」始终一致。
// ===========================================================================

interface EmbeddingVersionItem {
  id: string;
  knowledgeBaseId: string;
  modelId: string;
  llmModelId: string | null;
  dimensions: number;
  vectorTable: string;
  status: string;
  isActive: boolean;
  chunkTotal: number;
  chunkDone: number;
  chunkFailed: number;
  error: string | null;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const versions = ref<EmbeddingVersionItem[]>([]);
const versionsLoading = ref(false);
const embeddingModels = ref<LlmModel[]>([]);
const targetModelId = ref("");
const creatingVersion = ref(false);
const startingReEmbed = ref(false);

const activeVersion = computed(
  () => versions.value.find((v) => v.isActive) ?? null,
);

const versionStatusMeta: Record<
  string,
  { text: string; theme: "default" | "primary" | "success" | "warning" | "danger" }
> = {
  PENDING: { text: "待处理", theme: "warning" },
  PROCESSING: { text: "处理中", theme: "primary" },
  READY: { text: "就绪", theme: "success" },
  FAILED: { text: "有失败项", theme: "danger" },
  ARCHIVED: { text: "已归档", theme: "default" },
};

const versionProgress = (v: EmbeddingVersionItem) =>
  v.chunkTotal > 0 ? Math.round((v.chunkDone / v.chunkTotal) * 100) : 0;

const embeddingModelOptions = computed(() =>
  embeddingModels.value.map((m) => ({
    value: m.id,
    label: `${m.displayName || m.modelId}${
      m.embeddingDimensions ? ` · ${m.embeddingDimensions} 维` : ""
    }`,
  })),
);

const versionColumns = [
  { colKey: "modelId", title: "模型", width: 220 },
  { colKey: "dimensions", title: "维度", width: 90 },
  { colKey: "status", title: "状态", width: 110 },
  { colKey: "progress", title: "向量化进度", width: 220 },
  { colKey: "isActive", title: "生效", width: 90 },
  { colKey: "activatedAt", title: "激活时间", width: 170 },
  { colKey: "actions", title: "操作", width: 220 },
];

const loadVersions = async () => {
  versionsLoading.value = true;
  try {
    versions.value = await getEmbeddingVersions(kbId.value);
  } catch {
    versions.value = [];
  } finally {
    versionsLoading.value = false;
  }
};

const loadEmbeddingModels = async () => {
  try {
    embeddingModels.value = await getLlmModels("EMBEDDING");
  } catch {
    embeddingModels.value = [];
  }
};

/** 建目标版本（不生效），随后由用户点「开始重新向量化」 */
const onCreateTargetVersion = async () => {
  if (!targetModelId.value) {
    MessagePlugin.warning("请选择目标向量模型");
    return;
  }
  creatingVersion.value = true;
  try {
    await createEmbeddingVersion(kbId.value, {
      llmModelId: targetModelId.value,
    });
    MessagePlugin.success("目标版本已创建，请点击「开始重新向量化」");
    await loadVersions();
  } catch {
    /* 错误提示由拦截器处理 */
  } finally {
    creatingVersion.value = false;
  }
};

const onStartReEmbed = async (v: EmbeddingVersionItem, retryFailedOnly = false) => {
  startingReEmbed.value = true;
  try {
    await startReEmbed(kbId.value, v.id, retryFailedOnly);
    MessagePlugin.success("已提交后台任务，完成后才能激活该版本");
    await Promise.all([loadVersions(), startVersionPolling()]);
  } catch {
    /* 错误提示由拦截器处理 */
  } finally {
    startingReEmbed.value = false;
  }
};

const onActivateVersion = (v: EmbeddingVersionItem) => {
  const dialog = DialogPlugin.confirm({
    header: "切换到该向量版本",
    body: `确定切换到「${v.modelId} · ${v.dimensions} 维」？切换后检索将使用该版本，旧版本保留可回滚。`,
    confirmBtn: { content: "切换", theme: "primary" },
    onConfirm: async () => {
      await activateEmbeddingVersion(kbId.value, v.id);
      MessagePlugin.success("已切换生效");
      dialog.destroy();
      await Promise.all([loadVersions(), loadKBInfo()]);
    },
  });
};

const onDeleteVersion = (v: EmbeddingVersionItem) => {
  const dialog = DialogPlugin.confirm({
    header: "删除向量版本",
    body: `确定删除版本「${v.modelId} · ${v.dimensions} 维」？其向量数据会一并删除，且无法回滚到该版本。`,
    confirmBtn: { content: "删除", theme: "danger" },
    onConfirm: async () => {
      await removeEmbeddingVersion(kbId.value, v.id);
      MessagePlugin.success("已删除该版本");
      dialog.destroy();
      await loadVersions();
    },
  });
};

let versionTimer: number | null = null;
const startVersionPolling = () => {
  if (versionTimer !== null) return;
  versionTimer = window.setInterval(async () => {
    await loadVersions();
    const running = versions.value.some(
      (v) => v.status === "PROCESSING" || v.status === "PENDING",
    );
    if (!running) {
      if (versionTimer !== null) {
        clearInterval(versionTimer);
        versionTimer = null;
      }
      await loadKBInfo();
    }
  }, 3000);
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
// 表格列配置
// ===========================================================================
const columns = [
  { colKey: "fileName", title: "文件名", width: 280 },
  { colKey: "status", title: "状态", width: 120 },
  { colKey: "pageCount", title: "页数", width: 80 },
  { colKey: "errorMessage", title: "错误信息" },
  { colKey: "createdAt", title: "上传时间", width: 180 },
  { colKey: "actions", title: "操作", width: 120, align: "right" as const },
];

// ===========================================================================
// 生命周期
// ===========================================================================

onMounted(async () => {
  await Promise.all([
    loadKBInfo(),
    loadDocuments(),
    loadVersions(),
    loadEmbeddingModels(),
  ]);
  startPolling();
});

onBeforeUnmount(() => {
  stopPolling();
  if (versionTimer !== null) {
    clearInterval(versionTimer);
    versionTimer = null;
  }
});
</script>

<template>
  <div class="page-container">
    <!-- 头部面包屑 + 返回 -->
    <div class="detail-header">
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

        <!-- 向量模型配置 / 重新向量化 -->
        <div class="vector-config">
          <div class="vc-header">
            <span class="section-title">向量模型配置</span>
            <span class="vc-sub">切换模型不会改动现有向量：建新版本 → 后台重新向量化 → 校验通过后手动激活，旧版本保留可回滚</span>
          </div>

          <!-- 当前生效版本 -->
          <div class="vc-active" v-if="activeVersion">
            <div class="vc-active-left">
              <t-icon name="check-circle" class="vc-active-icon" />
              <div>
                <div class="vc-active-title">当前生效版本</div>
                <div class="vc-active-meta">{{ activeVersion.modelId }} · {{ activeVersion.dimensions }} 维</div>
              </div>
            </div>
            <div class="vc-active-right">
              <t-tag :theme="versionStatusMeta[activeVersion.status].theme" variant="light" size="small">
                {{ versionStatusMeta[activeVersion.status].text }}
              </t-tag>
              <span class="vc-active-progress">已向量化 {{ activeVersion.chunkDone }} / {{ activeVersion.chunkTotal }} 块</span>
            </div>
          </div>
          <div class="vc-active vc-active-warning" v-else>
            <div class="vc-active-left">
              <t-icon name="error-circle" class="vc-active-icon" />
              <div>
                <div class="vc-active-title">尚未有生效版本</div>
                <div class="vc-active-meta">请在下方创建并激活一个向量版本，否则检索不可用</div>
              </div>
            </div>
          </div>

          <!-- 新建目标版本 -->
          <div class="vc-create">
            <span class="vc-create-label">切换为其他向量模型：</span>
            <t-select
              v-model="targetModelId"
              :options="embeddingModelOptions"
              placeholder="选择目标向量模型（需在「模型管理」中已验证、含「向量化」能力）"
              filterable
              class="vc-select"
            />
            <t-button theme="primary" :loading="creatingVersion" :disabled="!targetModelId" @click="onCreateTargetVersion">
              创建目标版本
            </t-button>
          </div>

          <!-- 版本列表 -->
          <div class="vc-versions">
            <t-table
              :data="versions"
              :columns="versionColumns"
              row-key="id"
              hover
              size="medium"
              :loading="versionsLoading"
            >
              <template #modelId="{ row }">
                <div class="vc-model-cell">
                  <span class="vc-model-name">{{ row.modelId }}</span>
                  <span v-if="row.error" class="vc-model-err" :title="row.error">⚠ {{ row.error }}</span>
                </div>
              </template>

              <template #dimensions="{ row }">{{ row.dimensions }} 维</template>

              <template #status="{ row }">
                <t-tag :theme="versionStatusMeta[row.status].theme" variant="light" size="small">
                  {{ versionStatusMeta[row.status].text }}
                </t-tag>
              </template>

              <template #progress="{ row }">
                <div class="vc-progress-cell">
                  <t-progress :percentage="versionProgress(row)" :bar-height="6" />
                  <span class="vc-progress-text">
                    {{ row.chunkDone }}/{{ row.chunkTotal }} 块
                    <template v-if="row.chunkFailed"> · 失败 {{ row.chunkFailed }}</template>
                  </span>
                </div>
              </template>

              <template #isActive="{ row }">
                <t-tag v-if="row.isActive" theme="success" variant="light" size="small">生效中</t-tag>
                <span v-else class="placeholder">-</span>
              </template>

              <template #activatedAt="{ row }">
                {{ row.activatedAt ? formatDate(row.activatedAt) : '-' }}
              </template>

              <template #actions="{ row }">
                <t-button
                  v-if="row.status === 'READY' && !row.isActive"
                  variant="text" size="small" theme="primary"
                  @click="onActivateVersion(row)"
                >激活</t-button>
                <t-button
                  v-if="row.status !== 'READY' || row.chunkFailed > 0"
                  variant="text" size="small"
                  :loading="startingReEmbed && row.status !== 'READY'"
                  @click="onStartReEmbed(row, row.chunkFailed > 0)"
                >{{ row.status === 'READY' ? '重试失败项' : '重新向量化' }}</t-button>
                <t-button
                  v-if="!row.isActive"
                  variant="text" size="small" status="danger"
                  @click="onDeleteVersion(row)"
                >删除</t-button>
              </template>
            </t-table>

            <t-empty
              v-if="!versionsLoading && versions.length === 0"
              type="default"
              title="还没有向量版本"
              description="知识库尚未初始化向量数据，请在「切换为其他向量模型」中选择并创建版本"
            />
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
          <t-table v-else :data="documents" :columns="columns" row-key="id" hover size="medium">
            <template #fileName="{ row }">
              <div class="file-name-cell">
                <span class="file-icon">{{ fileIcon(row.fileType) }}</span>
                <div class="file-info">
                  <div class="file-name" :title="row.fileName">{{ row.fileName }}</div>
                  <div class="file-meta">{{ row.fileType }} · {{ formatSize(row.fileSize) }}</div>
                </div>
              </div>
            </template>

            <template #status="{ row }">
              <t-tag :theme="statusMap[row.status].theme" variant="light" size="small">
                {{ statusMap[row.status].text }}
              </t-tag>
              <t-progress v-if="row.status === 'PROCESSING'" :percentage="60" :bar-height="3" class="inline-progress" />
            </template>

            <template #pageCount="{ row }">{{ row.pageCount ?? '-' }}</template>

            <template #errorMessage="{ row }">
              <span v-if="row.status === 'FAILED' && row.errorMessage" class="error-text" :title="row.errorMessage">
                {{ row.errorMessage }}
              </span>
              <span v-else class="placeholder">-</span>
            </template>

            <template #createdAt="{ row }">{{ formatDate(row.createdAt) }}</template>

            <template #actions="{ row }">
              <t-button variant="text" size="small" status="danger" @click="openDeleteDialog(row)">
                <template #icon><t-icon name="delete" /></template>
                删除
              </t-button>
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
    <t-dialog v-model:visible="uploadDialogVisible" header="上传文档"
      :confirm-btn="{ content: uploading ? '上传中...' : `上传 ${fileList.length} 个文件`, theme: 'primary', loading: uploading, disabled: fileList.length === 0 }"
      cancel-btn="取消" width="520px" @confirm="submitUpload">
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
    </t-dialog>

    <!-- 删除确认 -->
    <t-dialog v-model:visible="deleteDialogVisible" header="删除文档"
      :confirm-btn="{ content: '确认删除', theme: 'danger', loading: deleting }" cancel-btn="取消" width="420px"
      @confirm="submitDelete">
      <p class="delete-tip">
        确定要删除文档「{{ deleteTarget?.fileName }}」吗？
        <br />删除后其关联的向量分块将一并清理。
      </p>
    </t-dialog>
  </div>
</template>

<style scoped lang="less">
// 面包屑头部
.detail-header {
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
  border: 1px solid var(--color-border);
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
      background: var(--primary-light);
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
  border: 1px solid var(--color-border);
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

// 向量模型配置
.vector-config {
  background: var(--color-bg-white);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--space-5);
  margin-bottom: var(--space-5);

  .vc-header {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: var(--space-4);

    .section-title {
      font-size: var(--font-md);
      font-weight: 600;
      color: var(--color-text);
    }

    .vc-sub {
      font-size: var(--font-sm);
      color: var(--color-text-tertiary);
    }
  }

  .vc-active {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
    background: var(--primary-light);
    border-radius: var(--radius-md);
    margin-bottom: var(--space-4);

    .vc-active-left {
      display: flex;
      align-items: center;
      gap: var(--space-3);

      .vc-active-icon {
        font-size: 22px;
        color: var(--primary);
      }

      .vc-active-title {
        font-size: var(--font-sm);
        font-weight: 600;
        color: var(--color-text);
      }

      .vc-active-meta {
        font-size: var(--font-sm);
        color: var(--color-text-tertiary);
        margin-top: 2px;
      }
    }

    .vc-active-right {
      display: flex;
      align-items: center;
      gap: var(--space-3);

      .vc-active-progress {
        font-size: var(--font-sm);
        color: var(--color-text-tertiary);
      }
    }

    &.vc-active-warning {
      background: var(--color-warning-light, #fff7e6);

      .vc-active-icon {
        color: var(--color-warning, #fa8c16);
      }
    }
  }

  .vc-create {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-bottom: var(--space-4);

    .vc-create-label {
      font-size: var(--font-sm);
      color: var(--color-text);
      white-space: nowrap;
    }

    .vc-select {
      flex: 1;
      max-width: 420px;
    }
  }

  .vc-versions {
    .vc-model-cell {
      display: flex;
      flex-direction: column;
      gap: 2px;

      .vc-model-name {
        font-size: var(--font-sm);
        font-weight: 500;
        color: var(--color-text);
      }

      .vc-model-err {
        font-size: 11px;
        color: var(--color-error);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 200px;
      }
    }

    .vc-progress-cell {
      display: flex;
      flex-direction: column;
      gap: 4px;

      .vc-progress-text {
        font-size: 11px;
        color: var(--color-text-tertiary);
      }
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
  background: var(--primary-light);
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
      background: var(--primary-light);
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
</style>
