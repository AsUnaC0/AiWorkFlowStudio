<script setup lang="ts">
import { computed, ref } from "vue";
import {
  formatFileSize,
  fileIcon,
  fileColor,
  FILE_FORMAT_LABELS,
  type GeneratedFile,
} from "@/types/files";

const props = defineProps<{
  file: GeneratedFile;
  /** 紧凑模式（用于消息流中） */
  compact?: boolean;
}>();

const emit = defineEmits<{
  (e: "preview", file: GeneratedFile): void;
  (e: "download", file: GeneratedFile): void;
}>();

const downloading = ref(false);

const typeLabel = computed(() => {
  const ext = (props.file.extension || props.file.format || "")
    .toLowerCase()
    .replace(/^\./, "");
  return FILE_FORMAT_LABELS[ext] ?? `${ext.toUpperCase()} 文件`;
});

const isReady = computed(() => props.file.status === "READY");
const isFailed = computed(() => props.file.status === "FAILED");

const onDownload = async () => {
  downloading.value = true;
  try {
    emit("download", props.file);
  } finally {
    // 交由父组件处理真实下载，这里只做短暂 loading 反馈
    setTimeout(() => (downloading.value = false), 600);
  }
};
</script>

<template>
  <div class="file-card" :class="{ compact, failed: isFailed }">
    <div class="file-icon" :style="{ color: fileColor(file.extension || file.format) }">
      <t-icon :name="fileIcon(file.extension || file.format)" size="22px" />
    </div>

    <div class="file-main">
      <div class="file-name" :title="file.fileName">{{ file.fileName }}</div>

      <div class="file-meta">
        <span class="meta-type">{{ typeLabel }}</span>
        <span class="meta-dot">·</span>
        <span class="meta-size">{{ formatFileSize(file.size) }}</span>
      </div>

      <div v-if="file.summary" class="file-summary">{{ file.summary }}</div>

      <div class="file-status">
        <t-tag v-if="isReady" theme="success" variant="light" size="small">已生成</t-tag>
        <t-tag v-else-if="isFailed" theme="danger" variant="light" size="small">生成失败</t-tag>
        <t-tag v-else theme="warning" variant="light" size="small">
          <t-icon name="loading" size="12px" />
          生成中
        </t-tag>
      </div>
    </div>

    <div class="file-actions">
      <t-button
        v-if="isReady"
        variant="outline"
        theme="primary"
        size="small"
        @click="emit('preview', file)"
      >
        <template #icon><t-icon name="browse" /></template>
        预览
      </t-button>
      <t-button
        v-if="isReady"
        variant="outline"
        size="small"
        :loading="downloading"
        @click="onDownload"
      >
        <template #icon><t-icon name="download" /></template>
        下载
      </t-button>
    </div>
  </div>
</template>

<style scoped lang="less">
@import "../../styles/variables.less";

.file-card {
  display: flex;
  align-items: flex-start;
  gap: @space-3;
  padding: @space-3 @space-4;
  border: 1px solid @color-border;
  border-radius: @radius-lg;
  background: @color-bg-surface;
  transition: all @duration-fast @ease-standard;
  width: 100%;
  max-width: 420px;

  &:hover {
    border-color: @primary;
    box-shadow: @shadow-sm;
  }

  &.failed {
    border-color: rgba(213, 73, 65, 0.4);
  }

  &.compact {
    padding: @space-2 @space-3;
    max-width: 340px;
  }
}

.file-icon {
  width: 40px;
  height: 40px;
  border-radius: @radius-md;
  background: @color-bg-hover;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.file-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.file-name {
  font-size: @font-sm;
  font-weight: 600;
  color: @color-text;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-meta {
  font-size: 11px;
  color: @color-text-tertiary;
  display: flex;
  align-items: center;
  gap: 4px;
}

.file-summary {
  font-size: 11px;
  color: @color-text-secondary;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.file-status {
  margin-top: 2px;
}

.file-actions {
  display: flex;
  flex-direction: column;
  gap: @space-1;
  flex-shrink: 0;

  .compact & {
    flex-direction: row;
  }
}
</style>
