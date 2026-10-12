<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { fetchFileBlob } from "@/api/files";
import type { GeneratedFile } from "@/types/files";

const props = defineProps<{ file: GeneratedFile }>();

const loading = ref(false);
const error = ref("");
const blobUrl = ref("");

const load = async () => {
  loading.value = true;
  error.value = "";
  if (blobUrl.value) {
    URL.revokeObjectURL(blobUrl.value);
    blobUrl.value = "";
  }
  try {
    blobUrl.value = await fetchFileBlob(props.file.id);
  } catch (err) {
    error.value = err instanceof Error ? err.message : "PDF 加载失败";
  } finally {
    loading.value = false;
  }
};

watch(() => props.file.id, load, { immediate: true });

onBeforeUnmount(() => {
  if (blobUrl.value) URL.revokeObjectURL(blobUrl.value);
});
</script>

<template>
  <div class="pdf-preview">
    <div v-if="loading" class="state">
      <t-loading size="small" text="正在加载 PDF…" />
    </div>
    <div v-else-if="error" class="state error">
      <t-icon name="error-circle" />
      <span>{{ error }}</span>
    </div>
    <iframe v-else-if="blobUrl" :src="blobUrl" class="pdf-frame" title="PDF 预览" />
  </div>
</template>

<style scoped lang="less">
.pdf-preview {
  width: 100%;
  height: 100%;
  min-height: 420px;
  display: flex;
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
}

.pdf-frame {
  flex: 1;
  width: 100%;
  height: 100%;
  min-height: 420px;
  border: none;
  background: #f4f4f5;
}
</style>
