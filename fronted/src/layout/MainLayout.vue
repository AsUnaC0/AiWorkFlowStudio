<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import AppSidebar from "./components/AppSidebar.vue";
import AppHeader from "./components/AppHeader.vue";

const sidebarCollapsed = ref(false);

const toggleSidebar = () => {
  sidebarCollapsed.value = !sidebarCollapsed.value;
};

// 点击外部关闭下拉（简单实现：Header 内部已有各自 showXxx 状态）
// 如需更完整的 click-outside 可后续引入 composable
</script>

<template>
  <div class="main-layout">
    <!-- 左侧 Sidebar -->
    <AppSidebar :collapsed="sidebarCollapsed" @toggle="toggleSidebar" />

    <!-- 右侧主区域 -->
    <div class="main-area">
      <!-- Header -->
      <AppHeader />

      <!-- 内容区（带页面过渡）-->
      <main class="main-content">
        <router-view v-slot="{ Component }">
          <transition name="page" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </main>
    </div>
  </div>
</template>

<style scoped lang="less">
@import "../styles/variables.less";

.main-layout {
  display: flex;
  height: 100vh;
  width: 100vw;
  background: @color-bg;
  overflow: hidden;
}

.main-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.main-content {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  background: @color-bg;
}

/* 页面过渡 */
.page-enter-active,
.page-leave-active {
  transition: opacity @duration-normal @ease-standard,
    transform @duration-normal @ease-standard;
}

.page-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

.page-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
