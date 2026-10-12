<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { MessagePlugin } from "tdesign-vue-next";
import { getFilePreview, downloadFile } from "@/api/files";
import { formatFileSize, type FilePreviewPayload, type GeneratedFile } from "@/types/files";
import PdfPreview from "./PdfPreview.vue";
import ImagePreview from "./ImagePreview.vue";
import MarkdownPreview from "./MarkdownPreview.vue";
import WordPreview from "./WordPreview.vue";
import ExcelPreview from "./ExcelPreview.vue";

const props = defineProps<{
  visible: boolean;
  file: GeneratedFile | null;
}>();

const emit = defineEmits<{
  (e: "update:visible", value: boolean): void;
}>();

const loading = ref(false);
const payload = ref<FilePreviewPayload | null>(null);
const downloading = ref(false);

const previewType = computed(() => props.file?.previewType ?? "text");

const loadPreview = async () => {
  if (!props.file) return;
  loading.value = true;
  payload.value = null;
  try {
    payload.value = await getFilePreview(props.file.id);
  } catch (err) {
    MessagePlugin.error(
      err instanceof Error ? err.message : "预览内容加载失败",
    );
  } finally {
    loading.value = false;
  }
};

watch(
  () => [props.visible, props.file?.id],
  () => {
    if (props.visible && props.file) loadPreview();
  },
  { immediate: true },
);

const onDownload = async () => {
  if (!props.file) return;
  downloading.value = true;
  try {
    await downloadFile(props.file);
  } catch (err) {
    MessagePlugin.error(err instanceof Error ? err.message : "下载失败");
  } finally {
    downloading.value = false;
  }
};

const close = () => emit("update:visible", false);
</script>

<template>
  <t-drawer
    :visible="visible"
    drawer-class-name="file-preview-drawer"
    placement="right"
    size="min(920px, 94vw)"
    :footer="false"
    :close-on-overlay-click="true"
    @close="close"
  >
    <template #header>
      <div class="drawer-header">
        <div class="file-title">
          <span class="title" :title="file?.fileName">{{ file?.fileName ?? "文件预览" }}</span>
          <span v-if="file" class="meta">{{ formatFileSize(file.size) }}</span>
        </div>

        <t-button
          size="small"
          variant="outline"
          :loading="downloading"
          @click="onDownload"
        >
          <template #icon><t-icon name="download" /></template>
          下载文件
        </t-button>
      </div>
    </template>

    <div class="preview-body">
      <div v-if="loading" class="state">
        <t-loading size="small" text="正在生成预览…" />
      </div>

      <div v-else-if="!payload" class="state dim">暂无预览内容</div>

      <PdfPreview v-else-if="previewType === 'pdf'" :file="file!" />

      <ImagePreview v-else-if="previewType === 'image'" :file="file!" />

      <MarkdownPreview
        v-else-if="previewType === 'markdown'"
        :payload="payload"
      />

      <WordPreview v-else-if="previewType === 'document'" :payload="payload" />

      <ExcelPreview
        v-else-if="previewType === 'spreadsheet' || previewType === 'csv'"
        :payload="payload"
      />

      <pre v-else class="text-preview">{{ payload.text || "（空文件）" }}</pre>
    </div>
  </t-drawer>
</template>

<style scoped lang="less">
.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;

  .file-title {
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .title {
    font-size: 15px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    flex-shrink: 0;
    font-size: 12px;
    color: #a1a1aa;
  }
}

.preview-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: auto;

  /* 抽屉内可用纵向空间更大，交给外层统一滚动，取消子组件的高度上限 */
  :deep(.word-preview),
  :deep(.markdown-preview) {
    max-height: none;
  }

  :deep(.table-wrap) {
    max-height: none;
  }
}

.state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 48px 0;
  font-size: 13px;
  color: #71717a;

  &.dim {
    color: #a1a1aa;
  }
}

.text-preview {
  margin: 0;
  padding: 16px;
  overflow: auto;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
}
</style>

<!-- 抽屉挂到 body 上，teleport 后拿不到 scoped 的 data-v，用 drawer-class-name 限定作用域 -->
<style lang="less">
.file-preview-drawer {
  .t-drawer__body {
    padding: 0;
    display: flex;
    flex-direction: column;
  }
}
</style>
