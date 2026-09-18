<script setup lang="ts">
import { Handle, Position } from "@vue-flow/core";

defineProps<{
  id: string;
  data: {
    label: string;
    nodeType: string;
  };
  selected?: boolean;
}>();
</script>

<template>
  <div class="custom-node" :class="[data.nodeType, { 'is-selected': selected }]">
    <!-- 上方连接句柄 (目标) -->
    <Handle v-if="data.nodeType !== 'start'" type="target" :position="Position.Top" class="node-handle" />

    <div class="node-content">
      <span class="node-icon">
        <template v-if="data.nodeType === 'start'"><t-icon name="poweroff"></t-icon></template>
        <template v-else-if="data.nodeType === 'llm'"><t-icon name="robot-1"></t-icon></template>
        <template v-else-if="data.nodeType === 'output'"><t-icon name="uninstall"></t-icon></template>
        <template v-else><t-icon name="edit"></t-icon></template>
      </span>
      <span class="node-label">{{ data.label }}</span>
    </div>

    <!-- 下方连接句柄 (源) -->
    <Handle v-if="data.nodeType !== 'output' && data.nodeType !== 'end'" type="source" :position="Position.Bottom"
      class="node-handle" />
  </div>
</template>

<style lang="less" scoped>
.custom-node {
  min-width: 140px;
  padding: 10px 16px;
  background: var(--color-bg-white);
  border: 1.5px solid #dcdfe6;
  border-radius: var(--radius-lg);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
  transition: all 0.2s ease;

  &.is-selected {
    border-color: var(--primary);
    box-shadow: 0 0 0 2px var(--primary-shadow);
  }

  &.start {
    border-left: 4px solid var(--color-success);
  }

  &.llm {
    border-left: 4px solid var(--primary);
  }

  &.output {
    border-left: 4px solid var(--color-warning);
  }

  .node-content {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);

    .node-label {
      font-size: var(--font-base);
      font-weight: 500;
      color: var(--color-text);
    }
  }

  .node-handle {
    width: 8px;
    height: 8px;
    background: var(--primary);
    border: 2px solid var(--color-bg-white);
  }
}
</style>
