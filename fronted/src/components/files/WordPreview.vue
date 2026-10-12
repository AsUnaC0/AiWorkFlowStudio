<script setup lang="ts">
import { computed } from "vue";
import type { FilePreviewPayload } from "@/types/files";

/**
 * Word 预览。
 * 后端用 mammoth 把 .docx 转成 HTML 并消毒后返回；
 * 下载时仍然使用原始 .docx 文件。
 */
const props = defineProps<{ payload: FilePreviewPayload }>();

const html = computed(() => props.payload.html || "");
</script>

<template>
  <div class="word-preview">
    <div class="doc-page">
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-if="html" class="doc-body" v-html="html"></div>
      <div v-else class="empty">未能解析该 Word 文档的内容</div>
    </div>
  </div>
</template>

<style scoped lang="less">
.word-preview {
  width: 100%;
  max-height: 62vh;
  overflow: auto;
  background: #f4f4f5;
  padding: 16px;
}

.doc-page {
  background: #fff;
  border: 1px solid #e8eaf0;
  border-radius: 8px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
  padding: 28px 32px;
  margin: 0 auto;
  max-width: 820px;
}

.empty {
  color: #a1a1aa;
  font-size: 13px;
  text-align: center;
  padding: 24px 0;
}

.doc-body {
  font-size: 14px;
  line-height: 1.8;
  color: #18181b;
  word-break: break-word;

  :deep(h1) {
    font-size: 22px;
    font-weight: 700;
    margin: 18px 0 10px;
  }
  :deep(h2) {
    font-size: 18px;
    font-weight: 700;
    margin: 16px 0 8px;
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
    padding-left: 24px;
  }
  :deep(table) {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0;
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
  :deep(img) {
    max-width: 100%;
  }
}
</style>
