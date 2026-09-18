<template>
  <div class="report-page">
    <div class="page-toolbar">
      <span class="page-title">报告</span>
    </div>
    <t-empty type="maintenance" title="AI 报告" description="报告功能开发中，敬请期待" />
  </div>
</template>

<script setup lang="ts"></script>

<style scoped lang="less">
.report-page {
  padding: var(--space-4) var(--space-8) var(--space-8);

  .page-toolbar {
    padding: var(--space-3) 0 var(--space-4);
  }

  .page-title {
    font-size: var(--font-xl);
    font-weight: 600;
    color: var(--color-text);
  }
}
</style>
