<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useUserStore } from "@/stores/user";
import { MessagePlugin } from "tdesign-vue-next";

const route = useRoute();
const router = useRouter();
const userStore = useUserStore();

// 菜单折叠状态
const collapsed = ref(false);

// 根据当前路由 path 动态计算高亮菜单项
const activeMenu = computed(() => {
  // /workflow 匹配工作空间菜单（包含 /workflow 和 /workflow/:id，但编辑器不走这个布局）
  if (route.path.startsWith("/workflow")) return "/workflow";
  return route.path;
});

// 菜单项定义
const menuItems = [
  { value: "/chat", label: "AI 聊天", icon: "chat" },
  { value: "/workflow", label: "工作空间", icon: "apps" },
  { value: "/knowledge", label: "知识库", icon: "library" },
];

// 点击菜单项跳转
const onMenuChange = (value: string | number) => {
  router.push(String(value));
};

// 切换折叠
const toggleCollapsed = () => {
  collapsed.value = !collapsed.value;
};

// 退出登录
const handleLogout = () => {
  userStore.logout();
  MessagePlugin.success("已退出登录");
  router.push("/login");
};
</script>

<template>
  <t-layout class="main-layout">
    <!-- 左侧菜单栏 -->
    <t-aside class="sidebar" :width="collapsed ? '64px' : '220px'">
      <div class="sidebar-logo">
        <span v-if="!collapsed" class="logo-text">AI WorkFlow</span>
        <span v-else class="logo-text-mini">AI</span>
      </div>
      <t-menu class="sidebar-menu" theme="light" :collapsed="collapsed" :value="activeMenu" :expand-type="'normal'"
        @change="onMenuChange">
        <t-menu-item v-for="item in menuItems" :key="item.value" :value="item.value">
          <template #icon>
            <t-icon :name="item.icon" />
          </template>
          {{ item.label }}
        </t-menu-item>
      </t-menu>
    </t-aside>

    <!-- 右侧主区域 -->
    <t-layout>
      <!-- 头部导航 -->
      <t-header class="header">
        <div class="header-left">
          <t-button variant="text" shape="square" @click="toggleCollapsed">
            <template #icon>
              <t-icon :name="collapsed ? 'chevron-right' : 'chevron-left'" />
            </template>
          </t-button>
          <span class="header-title">AI WorkFlow Studio</span>
        </div>

        <div class="header-right">
          <t-dropdown>
            <t-button variant="text">
              <template #icon>
                <t-icon name="user-circle" />
              </template>
              {{ userStore.userInfo?.username || "用户" }}
              <template #suffix>
                <t-icon name="caret-down-small" />
              </template>
            </t-button>
            <template #dropdown>
              <t-dropdown-menu>
                <t-dropdown-item @click="handleLogout">
                  <template #prefix><t-icon name="logout" /></template>
                  退出登录
                </t-dropdown-item>
              </t-dropdown-menu>
            </template>
          </t-dropdown>
        </div>
      </t-header>

      <!-- 内容区 -->
      <t-content class="main-content">
        <router-view />
      </t-content>
    </t-layout>
  </t-layout>
</template>

<style scoped>
.main-layout {
  height: 100vh;
  width: 100vw;
  background-color: var(--color-bg);
}

.sidebar {
  background-color: var(--color-bg-white);
  border-right: 1px solid var(--color-border);
  transition: width 0.2s ease;
  overflow: hidden;
  display: flex;
  flex-direction: column;

  .sidebar-logo {
    height: var(--header-height);
    display: flex;
    align-items: center;
    justify-content: center;
    border-bottom: 1px solid var(--color-border);
    flex-shrink: 0;

    .logo-text {
      font-size: var(--font-lg);
      font-weight: 700;
      color: var(--primary);
      letter-spacing: 1px;
      white-space: nowrap;
    }

    .logo-text-mini {
      font-size: var(--font-lg);
      font-weight: 700;
      color: var(--primary);
    }
  }

  .sidebar-menu {
    flex: 1;
    border-right: none;
  }
}

.header {
  height: var(--header-height);
  background-color: var(--color-bg-white);
  border-bottom: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--space-6);
  flex-shrink: 0;
  box-sizing: border-box;

  .header-left {
    display: flex;
    align-items: center;
    gap: var(--space-3);

    .header-title {
      font-size: var(--font-md);
      font-weight: 600;
      color: var(--color-text);
    }
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
}

.main-content {
  background-color: var(--color-bg);
  overflow: auto;
  height: calc(100vh - var(--header-height));
}
</style>
