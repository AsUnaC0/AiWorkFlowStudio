<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { fetchFileBlob } from "@/api/files";
import type { GeneratedFile } from "@/types/files";

const props = defineProps<{ file: GeneratedFile }>();

const loading = ref(false);
const error = ref("");
const blobUrl = ref("");
const scale = ref(1);

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
    error.value = err instanceof Error ? err.message : "图片加载失败";
  } finally {
    loading.value = false;
  }
};

const zoom = (delta: number) => {
  scale.value = Math.min(Math.max(scale.value + delta, 0.25), 4);
};

watch(() => props.file.id, load, { immediate: true });

onBeforeUnmount(() => {
  if (blobUrl.value) URL.revokeObjectURL(blobUrl.value);
});
</script>

<template>
  <div class="image-preview">
    <div class="toolbar">
      <t-button size="small" variant="outline" @click="zoom(-0.25)">
        <template #icon><t-icon name="zoom-out" /></template>
      </t-button>
      <span class="scale">{{ Math.round(scale * 100) }}%</span>
      <t-button size="small" variant="outline" @click="zoom(0.25)">
        <template #icon><t-icon name="zoom-in" /></template>
      </t-button>
    </div>

    <div class="canvas">
      <t-loading v-if="loading" size="small" text="加载中…" />
      <div v-else-if="error" class="error">{{ error }}</div>
      <img v-else-if="blobUrl" :src="blobUrl" :style="{ transform: `scale(${scale})` }" alt="预览" />
    </div>
  </div>
</template>

<style scoped lang="less">
.image-preview {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;

  .scale {
    font-size: 12px;
    color: #71717a;
    min-width: 48px;
    text-align: center;
  }
}

.canvas {
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
    transition: transform 0.15s ease;
    transform-origin: center center;
  }
}

.error {
  color: #d54941;
  font-size: 13px;
}
</style>
