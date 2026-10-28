<script setup lang="ts">
import MemoryPanel from "@/components/memory/MemoryPanel.vue";

/**
 * 记忆全屏页。
 *
 * 入口只保留在「Agent 管理 → 平台助理 → 记忆」Tab 里的「全屏」按钮，
 * 侧边栏不再单独放菜单 —— 记忆是平台助理的上下文资产，不是独立功能模块。
 *
 * 真正的实现全在 MemoryPanel（与 Tab 内嵌共用同一份）。
 */
defineOptions({ name: "MemoryGraph" });
</script>

<template>
  <MemoryPanel />
</template>
