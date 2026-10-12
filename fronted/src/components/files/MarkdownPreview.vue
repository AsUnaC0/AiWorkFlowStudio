<script setup lang="ts">
import { computed } from "vue";
import type { FilePreviewPayload } from "@/types/files";

/**
 * Markdown 预览。
 * HTML 由后端 marked 渲染 + sanitize-html 消毒后返回，前端直接注入，
 * 不再自行渲染，避免 AI 生成内容中的脚本注入。
 */
const props = defineProps<{ payload: FilePreviewPayload }>();

const html = computed(() => props.payload.html || "");
</script>

<template>
  <div class="markdown-preview">
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div v-if="html" class="md-body" v-html="html"></div>
    <pre v-else class="md-raw">{{ payload.text || "（空文件）" }}</pre>
  </div>
</template>

<style scoped lang="less">
.markdown-preview {
  width: 100%;
  max-height: 62vh;
  overflow: auto;
  padding: 4px 8px;
}

.md-raw {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
}

.md-body {
  font-size: 14px;
  line-height: 1.75;
  color: #18181b;
  word-break: break-word;

  :deep(h1) {
    font-size: 22px;
    font-weight: 700;
    margin: 16px 0 10px;
  }
  :deep(h2) {
    font-size: 18px;
    font-weight: 700;
    margin: 14px 0 8px;
  }
  :deep(h3) {
    font-size: 15px;
    font-weight: 600;
    margin: 12px 0 6px;
  }
  :deep(p) {
    margin: 8px 0;
  }
  :deep(ul),
  :deep(ol) {
    margin: 8px 0;
    padding-left: 22px;
  }
  :deep(li) {
    margin: 3px 0;
  }
  :deep(blockquote) {
    margin: 10px 0;
    padding: 6px 12px;
    border-left: 3px solid #7c5cfc;
    background: #f7f8fa;
    color: #52525b;
  }
  :deep(code) {
    background: #f4f4f5;
    padding: 1px 5px;
    border-radius: 4px;
    font-family: "Menlo", "Consolas", monospace;
    font-size: 12.5px;
  }
  :deep(pre) {
    background: #f4f4f5;
    padding: 12px;
    border-radius: 8px;
    overflow: auto;

    code {
      background: transparent;
      padding: 0;
    }
  }
  :deep(table) {
    width: 100%;
    border-collapse: collapse;
    margin: 10px 0;
    font-size: 13px;
  }
  :deep(th),
  :deep(td) {
    border: 1px solid #e8eaf0;
    padding: 6px 10px;
    text-align: left;
  }
  :deep(th) {
    background: #f7f8fa;
    font-weight: 600;
  }
  :deep(a) {
    color: #7c5cfc;
  }
  :deep(img) {
    max-width: 100%;
  }
  :deep(hr) {
    border: none;
    border-top: 1px solid #e8eaf0;
    margin: 14px 0;
  }
}
</style>
