<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import AppSidebar from "./components/AppSidebar.vue";
import AppHeader from "./components/AppHeader.vue";

const sidebarCollapsed = ref(false);

const toggleSidebar = () => {
  sidebarCollapsed.value = !sidebarCollapsed.value;
};

// 点击外部关闭下拉（简单实现：Header 内部已有各自 showXxx 状态）
// 如需更完整的 click-outside 可后续引入 composable

const router = useRouter();

/**
 * 需要缓存的页面组件名。
 *
 * 由路由 meta.keepAlive 声明，而不是在这里硬编码，新增缓存页面无需改本文件。
 *
 * 两个容易踩的点：
 *   1. <keep-alive :include> 匹配的是「组件 name」，不是路由 name。
 *      所以被缓存的页面组件必须用 defineOptions({ name: "Xxx" }) 显式声明，
 *      且与路由 name 保持一致（否则 include 匹配不上，缓存静默失效）。
 *   2. 只缓存声明过的页面。其余页面每次进入都重新加载，保证数据新鲜度。
 */
const cachedViews = computed(() =>
  router
    .getRoutes()
    .filter((r) => r.meta?.keepAlive === true && typeof r.name === "string")
    .map((r) => r.name as string),
);
</script>

<template>
  <div class="main-layout">
    <!-- 左侧 Sidebar -->
    <AppSidebar :collapsed="sidebarCollapsed" @toggle="toggleSidebar" />

    <!-- 右侧主区域 -->
    <div class="main-area">
      <!-- Header -->
      <AppHeader />

      <!-- 内容区（带页面过渡 + 按需缓存）-->
      <main class="main-content">
        <router-view v-slot="{ Component }">
          <transition name="page" mode="out-in">
            <keep-alive :include="cachedViews">
              <component :is="Component" />
            </keep-alive>
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
  overflow-y: scroll;        /* 始终显示滚动条，防止页面切换时宽度抖动 */
  overflow-x: hidden;
  background: @color-bg;
  scrollbar-gutter: stable;  /* 现代浏览器：滚动条轨道始终占位 */
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
