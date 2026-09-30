<script setup lang="ts">
import { computed } from "vue";
import { Handle, Position } from "@vue-flow/core";

const props = defineProps<{
  id: string;
  data: {
    label: string;
    nodeType: string;
  };
  selected?: boolean;
}>();

/** Condition 节点是否有分支可区分显示 */
const isCondition = computed(() => props.data.nodeType === "condition");
</script>

<template>
  <div
    class="custom-node"
    :class="[data.nodeType, { 'is-selected': selected }]"
  >
    <!-- 上方连接句柄 (target) -->
    <Handle
      v-if="data.nodeType !== 'start'"
      type="target"
      :position="Position.Top"
      class="node-handle"
    />

    <div class="node-content">
      <span class="node-icon">
        <template v-if="data.nodeType === 'start'">
          <t-icon name="poweroff"></t-icon>
        </template>
        <template v-else-if="data.nodeType === 'llm'">
          <t-icon name="robot-1"></t-icon>
        </template>
        <template v-else-if="data.nodeType === 'output'">
          <t-icon name="uninstall"></t-icon>
        </template>
        <template v-else-if="data.nodeType === 'condition'">
          <t-icon name="browse"></t-icon>
        </template>
        <template v-else-if="data.nodeType === 'http'">
          <t-icon name="link"></t-icon>
        </template>
        <template v-else-if="data.nodeType === 'rag'">
          <t-icon name="books"></t-icon>
        </template>
        <template v-else>
          <t-icon name="edit"></t-icon>
        </template>
      </span>
      <span class="node-label">{{ data.label }}</span>
    </div>

    <!-- Condition 节点：两个 source Handle（true / false） -->
    <template v-if="isCondition">
      <div class="branch-labels">
        <span class="branch-label true">TRUE</span>
        <span class="branch-label false">FALSE</span>
      </div>

      <Handle
        id="true"
        type="source"
        :position="Position.Right"
        class="node-handle branch true-handle"
        :style="{ top: '50%', transform: 'translateY(-50%)' }"
      />
      <Handle
        id="false"
        type="source"
        :position="Position.Right"
        class="node-handle branch false-handle"
        :style="{ top: '85%', transform: 'translateY(-50%)' }"
      />
    </template>

    <!-- 普通节点：单个底部 source Handle -->
    <Handle
      v-else-if="data.nodeType !== 'output' && data.nodeType !== 'end'"
      type="source"
      :position="Position.Bottom"
      class="node-handle"
    />
  </div>
</template>

<style lang="less" scoped>
.custom-node {
  position: relative;
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

  &.condition {
    min-width: 160px;
    padding-bottom: 32px; /* 给分支标签留空间 */
    border-left: 4px solid #8b5cf6;
  }

  &.http {
    border-left: 4px solid #14b8a6;
  }

  &.rag {
    border-left: 4px solid #f59e0b;
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

    &.branch.true-handle {
      background: var(--color-success);
      right: -8px;
    }

    &.branch.false-handle {
      background: var(--color-warning);
      right: -8px;
    }
  }

  .branch-labels {
    position: absolute;
    right: -42px;
    top: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    pointer-events: none;

    .branch-label {
      font-size: 10px;
      font-weight: 600;
      line-height: 1;
      padding: 2px 4px;
      border-radius: 3px;

      &.true {
        color: var(--color-success);
        margin-top: 48%;
      }

      &.false {
        color: var(--color-warning);
        margin-top: 35%;
      }
    }
  }
}
</style>
