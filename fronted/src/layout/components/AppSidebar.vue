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

// 根据当前路由计算高亮菜单
const activeMenu = computed(() => {
  if (route.path.startsWith("/workspace")) return "/workspace";
  if (route.path.startsWith("/knowledge")) return "/knowledge";
  if (route.path.startsWith("/friends")) return "/friends";
  if (route.path.startsWith("/skills")) return "/skills";
  if (route.path.startsWith("/mcp")) return "/mcp";
  return route.path;
});

// 菜单项分组
const menuGroups = computed(() => [
  {
    id: "chat",
    title: "CHAT",
    items: [
      {
        value: "/chat",
        label: "AI Chat",
        labelZh: "AI 对话",
        icon: "chat",
        badge: null as string | null,
      },
    ],
  },
  {
    id: "build",
    title: "BUILD",
    items: [
      {
        value: "/workspace",
        label: "Workspaces",
        labelZh: "工作空间",
        icon: "component-space",
        badge: null,
      },
      {
        value: "/skills",
        label: "Skills",
        labelZh: "Skills",
        icon: "code",
        badge: null,
      },
      {
        value: "/mcp",
        label: "MCP",
        labelZh: "MCP",
        icon: "plugin",
        badge: null,
      },
    ],
  },
  {
    id: "knowledge",
    title: "KNOWLEDGE",
    items: [
      {
        value: "/knowledge",
        label: "Knowledge Bases",
        labelZh: "知识库",
        icon: "data",
        badge: null,
      },
    ],
  },
  {
    id: "social",
    title: "SOCIAL",
    items: [
      {
        value: "/friends",
        label: "Friends",
        labelZh: "好友",
        icon: "usergroup",
        badge: null,
      },
    ],
  },
]);

const onMenuClick = (item: { value: string; disabled?: boolean }) => {
  if (item.disabled) return;
  router.push(item.value);
};

const handleToggle = () => emit("toggle");
</script>

<template>
  <aside class="app-sidebar" :class="{ collapsed: props.collapsed }">
    <!-- Logo 区域 -->
    <div class="sidebar-logo">
      <div class="logo-icon">✦</div>
      <div v-if="!props.collapsed" class="logo-text">
        <span class="logo-title">AI WorkFlow</span>
        <span class="logo-sub">Studio</span>
      </div>
    </div>

    <!-- 菜单分组 -->
    <nav class="sidebar-nav">
      <template v-for="group in menuGroups" :key="group.id">
        <!-- 分组标题（仅在展开时显示）-->
        <div v-if="group.title && !props.collapsed" class="nav-group-title">
          {{ group.title }}
        </div>

        <!-- 菜单项 -->
        <button v-for="item in group.items" :key="item.value" class="nav-item" :class="{
          active: activeMenu === item.value,
          disabled: item.disabled,
        }" :title="props.collapsed ? item.labelZh : ''" @click="onMenuClick(item)">
          <!-- 左侧高亮指示器 -->
          <span v-if="activeMenu === item.value" class="nav-indicator" />

          <span class="nav-icon">
            <t-icon :name="item.icon" />
          </span>

          <template v-if="!props.collapsed">
            <span class="nav-label">{{ item.labelZh }}</span>
            <span v-if="item.badge" class="nav-badge">{{ item.badge }}</span>
          </template>
        </button>
      </template>
    </nav>

    <!-- 底部区域 -->
    <div class="sidebar-footer">
      <button class="collapse-btn" :title="props.collapsed ? '展开' : '折叠'" @click="handleToggle">
        <t-icon :name="props.collapsed ? 'chevron-right' : 'chevron-left'" />
      </button>
    </div>
  </aside>
</template>

<style scoped lang="less">
@import "../../styles/variables.less";

.app-sidebar {
  width: @sidebar-width;
  flex-shrink: 0;
  height: 100vh;
  background: @color-bg-surface;
  border-right: 1px solid @color-border;
  display: flex;
  flex-direction: column;
  transition: width @duration-normal @ease-standard;
  overflow: hidden;
  position: relative;

  &.collapsed {
    width: @sidebar-collapsed-width;

    .nav-label,
    .nav-badge,
    .logo-sub,
    .user-detail {
      display: none;
    }
  }

  /* Logo */
  .sidebar-logo {
    height: @header-height;
    display: flex;
    align-items: center;
    gap: @space-3;
    padding: 0 @space-4;
    border-bottom: 1px solid @color-border;
    flex-shrink: 0;

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

  /* 菜单 */
  .sidebar-nav {
    flex: 1;
    padding: @space-3 @space-2;
    overflow-y: auto;
    overflow-x: hidden;

    .nav-group-title {
      font-size: 11px;
      font-weight: 600;
      color: @color-text-tertiary;
      letter-spacing: 0.08em;
      padding: @space-4 @space-3 @space-2;
      white-space: nowrap;
    }

    .nav-item {
      width: 100%;
      display: flex;
      align-items: center;
      gap: @space-3;
      padding: @space-2 @space-3;
      margin-bottom: 2px;
      border: none;
      background: transparent;
      border-radius: @radius-md;
      cursor: pointer;
      color: @color-text-secondary;
      font-size: @font-base;
      font-weight: 500;
      position: relative;
      transition: background-color @duration-fast @ease-standard,
        color @duration-fast @ease-standard;

      .nav-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 18px;
        flex-shrink: 0;
        width: 20px;
        height: 20px;
      }

      .nav-label {
        white-space: nowrap;
        flex: 1;
        text-align: left;
      }

      .nav-badge {
        font-size: 10px;
        font-weight: 600;
        color: @primary;
        background: @primary-light;
        padding: 1px 6px;
        border-radius: @radius-pill;
      }

      /* 默认 hover */
      &:hover:not(.disabled):not(.active) {
        background: @color-bg-hover;
        color: @color-text;
      }

      /* Active 状态 */
      &.active {
        background: @primary-light;
        color: @primary;

        .nav-icon {
          color: @primary;
        }

        .nav-indicator {
          position: absolute;
          left: -@space-2;
          top: 50%;
          transform: translateY(-50%);
          width: 2px;
          height: 20px;
          background: @primary;
          border-radius: 2px;
          animation: indicator-slide-in @duration-fast @ease-out;
        }
      }

      /* Disabled */
      &.disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }
  }

  /* 底部 */
  .sidebar-footer {
    border-top: 1px solid @color-border;
    padding: @space-3 @space-2;
    display: flex;
    align-items: center;
    gap: @space-2;
    flex-shrink: 0;

    .user-info {
      flex: 1;
      display: flex;
      align-items: center;
      gap: @space-2;
      padding: @space-1 @space-2;
      border-radius: @radius-md;
      transition: background-color @duration-fast;

      &:hover {
        background: @color-bg-hover;
      }

      .avatar {
        width: 32px;
        height: 32px;
        border-radius: @radius-md;
        background: linear-gradient(135deg, @primary 0%, lighten(@primary, 10%) 100%);
        color: #fff;
        font-size: @font-base;
        font-weight: 600;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }

      .user-detail {
        min-width: 0;

        .user-name {
          font-size: @font-sm;
          font-weight: 600;
          color: @color-text;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .user-role {
          font-size: 11px;
          color: @color-text-tertiary;
          white-space: nowrap;
        }
      }

      &.collapsed {
        justify-content: center;
      }
    }

    .collapse-btn {
      width: 32px;
      height: 32px;
      border: none;
      background: transparent;
      border-radius: @radius-md;
      display: flex;
      align-items: center;
      justify-content: center;
      color: @color-text-tertiary;
      cursor: pointer;
      flex-shrink: 0;
      transition: all @duration-fast;

      &:hover {
        background: @color-bg-hover;
        color: @primary;
      }
    }
  }
}

@keyframes indicator-slide-in {
  from {
    opacity: 0;
    transform: translateY(-50%) translateX(-4px);
  }

  to {
    opacity: 1;
    transform: translateY(-50%) translateX(0);
  }
}
</style>
