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
  <div
    class="custom-node"
    :class="[data.nodeType, { 'is-selected': selected }]"
  >
    <!-- 上方连接句柄 (目标) -->
    <Handle
      v-if="data.nodeType !== 'start'"
      type="target"
      :position="Position.Top"
      class="node-handle"
    />

    <div class="node-content">
      <span class="node-icon">
        <template v-if="data.nodeType === 'start'">🚀</template>
        <template v-else-if="data.nodeType === 'llm'">🤖</template>
        <template v-else-if="data.nodeType === 'output'">📤</template>
        <template v-else>🧩</template>
      </span>
      <span class="node-label">{{ data.label }}</span>
    </div>

    <!-- 下方连接句柄 (源) -->
    <Handle
      v-if="data.nodeType !== 'output' && data.nodeType !== 'end'"
      type="source"
      :position="Position.Bottom"
      class="node-handle"
    />
  </div>
</template>

<style lang="less" scoped>
.custom-node {
  min-width: 140px;
  padding: 10px 16px;
  background: #ffffff;
  border: 1.5px solid #dcdfe6;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
  transition: all 0.2s ease;

  &.is-selected {
    border-color: #0052d9;
    box-shadow: 0 0 0 2px rgba(0, 82, 217, 0.2);
  }

  &.start {
    border-left: 4px solid #2ba471;
  }

  &.llm {
    border-left: 4px solid #0052d9;
  }

  &.output {
    border-left: 4px solid #e37318;
  }

  .node-content {
    display: flex;
    align-items: center;
    gap: 8px;

    .node-label {
      font-size: 14px;
      font-weight: 500;
      color: #1d1d1f;
    }
  }

  .node-handle {
    width: 8px;
    height: 8px;
    background: #0052d9;
    border: 2px solid #ffffff;
  }
}
</style>
