<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { MessagePlugin } from "tdesign-vue-next";
import {
  getChatFilePreview,
  fetchChatFileBlob,
  downloadChatFile,
} from "@/api/files";
import {
  formatFileSize,
  previewTypeFromExt,
  type FilePreviewPayload,
  type ChatAttachment,
} from "@/types/files";
import MarkdownPreview from "./MarkdownPreview.vue";
import WordPreview from "./WordPreview.vue";
import ExcelPreview from "./ExcelPreview.vue";

const props = defineProps<{
  visible: boolean;
  attachment: ChatAttachment | null;
}>();

const emit = defineEmits<{
  (e: "update:visible", value: boolean): void;
}>();

const loading = ref(false);
const payload = ref<FilePreviewPayload | null>(null);
const downloading = ref(false);

const previewType = computed(
  () => props.attachment?.previewType || previewTypeFromExt(props.attachment?.extension) || "text",
);

// 图片 / PDF 走原始文件流
const blobUrl = ref("");
const blobError = ref("");

const loadPreview = async () => {
  if (!props.attachment) return;
  loading.value = true;
  payload.value = null;
  blobError.value = "";
  if (blobUrl.value) {
    URL.revokeObjectURL(blobUrl.value);
    blobUrl.value = "";
  }
  try {
    if (previewType.value === "pdf" || previewType.value === "image") {
      blobUrl.value = await fetchChatFileBlob(props.attachment.id);
    } else {
      payload.value = await getChatFilePreview(props.attachment.id);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "预览内容加载失败";
    if (previewType.value === "pdf" || previewType.value === "image") {
      blobError.value = msg;
    } else {
      MessagePlugin.error(msg);
    }
  } finally {
    loading.value = false;
  }
};

watch(
  () => [props.visible, props.attachment?.id],
  () => {
    if (props.visible && props.attachment) loadPreview();
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (blobUrl.value) URL.revokeObjectURL(blobUrl.value);
});

const onDownload = async () => {
  if (!props.attachment) return;
  downloading.value = true;
  try {
    await downloadChatFile(props.attachment);
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
    drawer-class-name="chat-file-preview-drawer"
    placement="right"
    size="min(920px, 94vw)"
    :footer="false"
    :close-on-overlay-click="true"
    @close="close"
  >
    <template #header>
      <div class="drawer-header">
        <div class="file-title">
          <span class="title" :title="attachment?.originalName">{{
            attachment?.originalName ?? "附件预览"
          }}</span>
          <span v-if="attachment" class="meta">{{
            formatFileSize(attachment.size)
          }}</span>
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

      <div v-else-if="blobError" class="state error">
        <t-icon name="error-circle" />
        <span>{{ blobError }}</span>
      </div>

      <div v-else-if="!payload && !blobUrl" class="state dim">
        暂无预览内容
      </div>

      <iframe
        v-else-if="previewType === 'pdf' && blobUrl"
        :src="blobUrl"
        class="pdf-frame"
        title="PDF 预览"
      />

      <div v-else-if="previewType === 'image' && blobUrl" class="image-wrap">
        <img :src="blobUrl" alt="预览" />
      </div>

      <MarkdownPreview
        v-else-if="previewType === 'markdown' && payload"
        :payload="payload"
      />

      <WordPreview
        v-else-if="previewType === 'document' && payload"
        :payload="payload"
      />

      <ExcelPreview
        v-else-if="
          (previewType === 'spreadsheet' || previewType === 'csv') && payload
        "
        :payload="payload"
      />

      <pre v-else class="text-preview">{{ payload?.text || "（空文件）" }}</pre>
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

  :deep(.word-preview),
  :deep(.markdown-preview) {
    max-height: none;
  }

  :deep(.table-wrap) {
    max-height: none;
  }
}

.pdf-frame {
  flex: 1;
  width: 100%;
  height: 100%;
  min-height: 420px;
  border: none;
  background: #f4f4f5;
}

.image-wrap {
  flex: 1;
  min-height: 400px;
  overflow: auto;
  background: #f4f4f5;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;

  img {
    max-width: 100%;
  }
}

.state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 13px;
  color: #71717a;

  &.error {
    color: #d54941;
  }

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
.chat-file-preview-drawer {
  .t-drawer__body {
    padding: 0;
    display: flex;
    flex-direction: column;
  }
}
</style>
