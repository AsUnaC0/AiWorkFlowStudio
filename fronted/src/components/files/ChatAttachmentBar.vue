<script setup lang="ts">
import { ref } from "vue";
import { fileIcon, fileColor, formatFileSize } from "@/types/files";
import type { ChatAttachment } from "@/types/files";

const props = defineProps<{
  attachments: ChatAttachment[];
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: "add", files: File[]): void;
  (e: "remove", id: string): void;
  (e: "preview", att: ChatAttachment): void;
  (e: "download", att: ChatAttachment): void;
}>();

const inputRef = ref<HTMLInputElement | null>(null);

const statusText = (s: ChatAttachment["status"]) => {
  switch (s) {
    case "UPLOADED":
      return "已上传";
    case "PROCESSING":
      return "解析中…";
    case "READY":
      return "已就绪";
    case "FAILED":
      return "解析失败";
    default:
      return "";
  }
};

const onPick = () => inputRef.value?.click();

const onChange = (e: Event) => {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  if (files.length) emit("add", files);
};
</script>

<template>
  <div class="attachment-bar">
    <input
      ref="inputRef"
      type="file"
      class="hidden-input"
      multiple
      @change="onChange"
    />

    <!-- 附件列表：上传中 / 解析中 / 就绪 / 失败 都展示 -->
    <div v-if="attachments.length" class="att-chips">
      <div
        v-for="att in attachments"
        :key="att.id"
        class="att-chip"
        :class="att.status.toLowerCase()"
      >
        <t-icon
          :name="fileIcon(att.extension)"
          :style="{ color: fileColor(att.extension) }"
          class="att-icon"
        />
        <span class="att-name" :title="att.originalName">{{
          att.originalName
        }}</span>
        <span class="att-size">{{ formatFileSize(att.size) }}</span>
        <span class="att-status">{{ statusText(att.status) }}</span>

        <div class="att-actions">
          <button
            v-if="att.status === 'READY'"
            class="icon-btn"
            title="预览"
            @click="emit('preview', att)"
          >
            <t-icon name="browse" />
          </button>
          <button
            v-if="att.status === 'READY'"
            class="icon-btn"
            title="下载"
            @click="emit('download', att)"
          >
            <t-icon name="download" />
          </button>
          <button
            class="icon-btn danger"
            title="移除"
            @click="emit('remove', att.id)"
          >
            <t-icon name="close" />
          </button>
        </div>
      </div>
    </div>

    <button
      class="attach-btn"
      :class="{ disabled }"
      :disabled="disabled"
      title="上传文件（PDF / Word / Excel / 图片等）"
      @click="onPick"
    >
      <t-icon name="link" />
    </button>
  </div>
</template>

<style scoped lang="less">
.attachment-bar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.hidden-input {
  display: none;
}

.att-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.att-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 260px;
  padding: 4px 8px;
  border-radius: 8px;
  background: var(--color-bg-surface, #f4f4f5);
  border: 1px solid var(--color-border, #e4e4e7);
  font-size: 12px;
  line-height: 1.4;

  &.failed {
    border-color: #f0a3a3;
    background: #fff1f0;
  }
}

.att-icon {
  flex-shrink: 0;
  font-size: 15px;
}

.att-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 120px;
}

.att-size {
  flex-shrink: 0;
  color: #a1a1aa;
}

.att-status {
  flex-shrink: 0;
  color: #71717a;

  .att-chip.processing & {
    color: #2563eb;
  }

  .att-chip.failed & {
    color: #d54941;
  }

  .att-chip.ready & {
    color: #16a34a;
  }
}

.att-actions {
  display: inline-flex;
  gap: 2px;
  margin-left: 2px;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  color: #71717a;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s;

  &:hover {
    background: rgba(0, 0, 0, 0.06);
    color: #2563eb;
  }

  &.danger:hover {
    color: #d54941;
  }
}

.attach-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--color-border, #e4e4e7);
  border-radius: 8px;
  background: transparent;
  color: #71717a;
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;

  &:hover:not(.disabled) {
    color: var(--primary, #2563eb);
    border-color: var(--primary, #2563eb);
    background: var(--primary-light, #eff6ff);
  }

  &.disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}
</style>
