<template>
  <div class="chat-page">
    <div class="page-toolbar">
      <span class="page-title">AI 聊天</span>
    </div>
  </div>
</template>

<script setup lang="ts"></script>

<style scoped>
.chat-page {
  padding: var(--space-4) var(--space-8) var(--space-8);
  min-height: 100%;
  box-sizing: border-box;

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
