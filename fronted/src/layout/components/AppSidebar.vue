<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";

const props = defineProps<{
  collapsed: boolean;
}>();

const emit = defineEmits<{
  (e: "toggle"): void;
}>();

const route = useRoute();
const router = useRouter();

// 根据当前路由计算高亮菜单 value
const activeMenu = computed(() => {
  if (route.path === "/dashboard") return "/dashboard";
  if (route.path.startsWith("/workspace")) return "/workspace";
  if (route.path.startsWith("/knowledge")) return "/knowledge";
  if (route.path.startsWith("/friends")) return "/friends";
  if (route.path.startsWith("/skills")) return "/skills";
  if (route.path.startsWith("/mcp")) return "/mcp";
  if (route.path.startsWith("/agents")) return "/agents";
  if (route.path.startsWith("/providers")) return "/providers";
  if (route.path.startsWith("/chat")) return "/chat";
  return route.path;
});

// 菜单项数据
interface SidebarMenuItem {
  value: string;
  label: string;
  icon: string;
  disabled?: boolean;
}
interface SidebarMenuGroup {
  title: string;
  items: SidebarMenuItem[];
}

const menuGroups = computed<SidebarMenuGroup[]>(() => [
  {
    title: "CHAT",
    items: [
      { value: "/chat", label: "AI 对话", icon: "chat" },
    ],
  },
  {
    title: "BUILD",
    items: [
      { value: "/agents", label: "Agent 管理", icon: "chat" },
      { value: "/workspace", label: "工作空间", icon: "component-space" },
      { value: "/skills", label: "Skills", icon: "code" },
      { value: "/mcp", label: "MCP", icon: "link" },
    ],
  },
  {
    title: "KNOWLEDGE",
    items: [
      { value: "/knowledge", label: "知识库", icon: "data" },
    ],
  },
  {
    title: "SOCIAL",
    items: [
      { value: "/friends", label: "好友", icon: "usergroup" },
    ],
  },
  {
    title: "OVERVIEW",
    items: [
      { value: "/dashboard", label: "控制台", icon: "dashboard" },
    ],
  },
  {
    title: "SETTINGS",
    items: [
      { value: "/providers", label: "模型管理", icon: "server" },
    ],
  },
]);

const handleMenuChange = (val: string | number) => {
  const target = String(val);
  if (target !== route.path) {
    router.push(target);
  }
};

const toggleCollapsed = () => emit("toggle");
</script>

<template>
  <t-menu class="app-sidebar" :collapsed="props.collapsed" :width="['240px', '64px']" :value="activeMenu" theme="light"
    @change="handleMenuChange">
    <!-- Logo Slot -->
    <template #logo>
      <div class="sidebar-logo">
        <div class="logo-icon">✦</div>
        <div v-if="!props.collapsed" class="logo-text">
          <span class="logo-title">LUMOBI</span>
          <span class="logo-sub">Studio</span>
        </div>
      </div>
    </template>

    <!-- 菜单分组 -->
    <template v-for="group in menuGroups" :key="group.title">
      <t-menu-group :title="group.title">
        <t-menu-item v-for="item in group.items" :key="item.value" :value="item.value" :disabled="item.disabled">
          <template #icon>
            <t-icon :name="item.icon" />
          </template>
          {{ item.label }}
        </t-menu-item>
      </t-menu-group>
    </template>

    <!-- 操作区域 Slot（折叠按钮） -->
    <template #operations>
      <div class="sidebar-operations">
        <t-button variant="text" shape="square" size="small" :title="props.collapsed ? '展开' : '折叠'"
          @click="toggleCollapsed">
          <template #icon>
            <t-icon :name="props.collapsed ? 'chevron-right' : 'chevron-left'" />
          </template>
        </t-button>
      </div>
    </template>
  </t-menu>
</template>

<style scoped lang="less">
@import "../../styles/variables.less";

.app-sidebar {
  height: 100vh;
  border-right: 1px solid @color-border;
  background: @color-bg-surface;

  /* Logo 区域 */
  .sidebar-logo {
    display: flex;
    align-items: center;
    gap: @space-3;

    .logo-icon {
      width: 32px;
      height: 32px;
      border-radius: @radius-lg;
      background: linear-gradient(135deg, @primary 0%, lighten(@primary, 8%) 100%);
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      font-weight: 700;
      flex-shrink: 0;
      box-shadow: 0 2px 8px @primary-shadow;
    }

    .logo-text {
      display: flex;
      flex-direction: column;
      line-height: 1.1;
      min-width: 0;

      .logo-title {
        font-size: @font-sm;
        font-weight: 600;
        color: @color-text;
        white-space: nowrap;
      }

      .logo-sub {
        font-size: 10px;
        font-weight: 500;
        color: @primary;
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }
    }
  }

  /* 折叠按钮区 */
  .sidebar-operations {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* === 穿透 t-menu 内部样式 —— 统一 active 态和视觉 === */
  :deep(.t-menu) {
    &__item.is-active {
      background: @primary-light;
      color: @primary;
      font-weight: 600;
      position: relative;

      /* 左侧高亮指示条 */
      &::before {
        content: "";
        position: absolute;
        left: 0;
        top: 50%;
        transform: translateY(-50%);
        width: 3px;
        height: 20px;
        background: @primary;
        border-radius: 0 2px 2px 0;
      }
    }

    &__item {
      border-radius: @radius-md;
      margin-bottom: 2px;
      font-weight: 500;
      color: @color-text-secondary;

      &:hover:not(.is-active):not(.is-disabled) {
        background: @color-bg-hover;
        color: @color-text;
      }
    }

    &__group-title {
      font-size: 11px;
      font-weight: 600;
      color: @color-text-tertiary;
      letter-spacing: 0.08em;
    }
  }
}
</style>
