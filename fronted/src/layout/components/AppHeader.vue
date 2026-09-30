<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useUserStore } from "@/stores/user";
import { useWorkspace } from "@/composables/useWorkspace";
import { useClickOutside } from "@/composables/useClickOutside";
import { MessagePlugin } from "tdesign-vue-next";

const router = useRouter();
const userStore = useUserStore();
const { workspaces, fetchWorkspaces } = useWorkspace();

const currentWorkspace = ref<{ id: string; name: string } | null>(null);
const showWorkspaceDropdown = ref(false);
const showUserDropdown = ref(false);

// DOM refs
const wsRef = ref<HTMLElement | null>(null);
const userRef = ref<HTMLElement | null>(null);

// 点击外部关闭下拉
useClickOutside(wsRef, () => {
  showWorkspaceDropdown.value = false;
});
useClickOutside(userRef, () => {
  showUserDropdown.value = false;
});

// 切换 workspace
const selectWorkspace = (ws: { id: string; name: string }) => {
  currentWorkspace.value = ws;
  showWorkspaceDropdown.value = false;
};

// 退出登录
const handleLogout = () => {
  userStore.logout();
  MessagePlugin.success("已退出登录");
  router.push("/login");
};

onMounted(async () => {
  await fetchWorkspaces();
  if (workspaces.value.length > 0) {
    currentWorkspace.value = {
      id: workspaces.value[0].id,
      name: workspaces.value[0].name,
    };
  }
});
</script>

<template>
  <header class="app-header">
    <!-- 左侧：占位（Sidebar 独立控制宽度）-->
    <div class="header-left"></div>

    <!-- 中间：Workspace 选择器 -->
    <div class="header-center">
      <div ref="wsRef" class="workspace-switcher">
        <!-- <button class="ws-trigger" @click="showWorkspaceDropdown = !showWorkspaceDropdown">
          <span class="ws-icon">
            <t-icon name="layers" />
          </span>
          <span class="ws-name">
            {{ currentWorkspace?.name || "选择 Workspace" }}
          </span>
          <t-icon class="ws-caret" name="caret-down-small" />
        </button> -->

        <!-- Workspace 下拉 -->
        <transition name="fast-fade">
          <div v-if="showWorkspaceDropdown" class="ws-dropdown">
            <div class="dropdown-section-title">Your Workspaces</div>
            <button v-for="ws in workspaces" :key="ws.id" class="dropdown-item"
              :class="{ active: currentWorkspace?.id === ws.id }" @click="selectWorkspace(ws)">
              <span class="dropdown-item-icon">
                <t-icon name="layers" />
              </span>
              <span class="dropdown-item-label">{{ ws.name }}</span>
              <span v-if="currentWorkspace?.id === ws.id" class="dropdown-item-check">
                <t-icon name="check" />
              </span>
            </button>

            <div class="dropdown-divider" />

            <button class="dropdown-item create">
              <span class="dropdown-item-icon">
                <t-icon name="add" />
              </span>
              <span class="dropdown-item-label">Create workspace</span>
            </button>
          </div>
        </transition>
      </div>
    </div>

    <!-- 右侧：通知 + 用户 -->
    <div class="header-right">
      <!-- 通知 -->
      <button class="icon-btn" title="Notifications">
        <t-icon name="notification" />
        <span class="badge-dot" />
      </button>

      <!-- 用户菜单 -->
      <div ref="userRef" class="user-wrapper">
        <button class="user-trigger" @click="showUserDropdown = !showUserDropdown">
          <div class="avatar">
            {{ (userStore.userInfo?.username || "U").charAt(0).toUpperCase() }}
          </div>
          <span class="user-name">{{ userStore.userInfo?.username || "用户" }}</span>
        </button>

        <transition name="fast-fade">
          <div v-if="showUserDropdown" class="user-dropdown">
            <div class="user-dropdown-header">
              <div class="dropdown-avatar">
                {{ (userStore.userInfo?.username || "U").charAt(0).toUpperCase() }}
              </div>
              <div class="dropdown-user-info">
                <div class="dropdown-username">
                  {{ userStore.userInfo?.username || "用户" }}
                </div>
                <div class="dropdown-email">
                  {{ userStore.userInfo?.email || "" }}
                </div>
              </div>
            </div>

            <div class="dropdown-divider" />

            <button class="dropdown-item">
              <span class="dropdown-item-icon">
                <t-icon name="user" />
              </span>
              <span class="dropdown-item-label">Profile</span>
            </button>

            <button class="dropdown-item">
              <span class="dropdown-item-icon">
                <t-icon name="api" />
              </span>
              <span class="dropdown-item-label">API Keys</span>
            </button>

            <button class="dropdown-item">
              <span class="dropdown-item-icon">
                <t-icon name="setting" />
              </span>
              <span class="dropdown-item-label">Settings</span>
            </button>

            <div class="dropdown-divider" />

            <button class="dropdown-item danger" @click="handleLogout">
              <span class="dropdown-item-icon">
                <t-icon name="logout" />
              </span>
              <span class="dropdown-item-label">Logout</span>
            </button>
          </div>
        </transition>
      </div>
    </div>
  </header>
</template>

<style scoped lang="less">
@import "../../styles/variables.less";

.app-header {
  height: @header-height;
  background: @color-bg-surface;
  border-bottom: 1px solid @color-border;
  display: flex;
  align-items: center;
  flex-shrink: 0;
  position: relative;
  z-index: 100;

  .header-left {
    flex-shrink: 0;
    /* Sidebar 宽度由 Sidebar 自身控制 */
  }

  .header-center {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: @space-2;
    padding-right: @space-4;
  }
}

/* Workspace Switcher */
.workspace-switcher {
  position: relative;

  .ws-trigger {
    display: flex;
    align-items: center;
    gap: @space-2;
    padding: @space-1 @space-3;
    background: transparent;
    border: 1px solid transparent;
    border-radius: @radius-md;
    color: @color-text;
    cursor: pointer;
    transition: all @duration-fast;

    &:hover {
      background: @color-bg-hover;
      border-color: @color-border;
    }

    .ws-icon {
      color: @primary;
      display: flex;
      align-items: center;
    }

    .ws-name {
      font-size: @font-sm;
      font-weight: 500;
      max-width: 200px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .ws-caret {
      color: @color-text-tertiary;
      font-size: 12px;
    }
  }
}

/* 下拉菜单通用 */
.ws-dropdown,
.user-dropdown {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  min-width: 220px;
  background: @color-bg-surface;
  border: 1px solid @color-border;
  border-radius: @radius-lg;
  box-shadow: @shadow-float;
  padding: @space-2;
  z-index: 1000;
  animation: fade-scale-in @duration-fast @ease-out;
}

.ws-dropdown {
  right: auto;
  left: 50%;
  transform: translateX(-50%);
}

.user-dropdown {
  min-width: 240px;
}

.dropdown-section-title {
  font-size: 11px;
  font-weight: 600;
  color: @color-text-tertiary;
  letter-spacing: 0.05em;
  padding: @space-2 @space-3 @space-1;
}

.dropdown-divider {
  height: 1px;
  background: @color-border;
  margin: @space-1 @space-2;
}

.dropdown-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: @space-2;
  padding: @space-2 @space-3;
  border: none;
  background: transparent;
  border-radius: @radius-md;
  cursor: pointer;
  color: @color-text;
  font-size: @font-sm;
  text-align: left;
  transition: background-color @duration-fast;

  &:hover {
    background: @color-bg-hover;
  }

  &.active {
    background: @primary-light;
    color: @primary;
  }

  &.danger {
    color: @color-error;

    &:hover {
      background: lighten(@color-error, 42%);
    }
  }

  &.create {
    color: @primary;
    font-weight: 500;
  }

  .dropdown-item-icon {
    display: flex;
    align-items: center;
    color: @color-text-secondary;
    font-size: 16px;

    .active & {
      color: @primary;
    }
  }

  .dropdown-item-label {
    flex: 1;
  }

  .dropdown-item-check {
    color: @primary;
  }
}

/* 用户下拉 Header */
.user-dropdown-header {
  display: flex;
  align-items: center;
  gap: @space-3;
  padding: @space-3;
}

.dropdown-avatar {
  width: 40px;
  height: 40px;
  border-radius: @radius-lg;
  background: linear-gradient(135deg, @primary 0%, lighten(@primary, 10%) 100%);
  color: #fff;
  font-size: @font-lg;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.dropdown-user-info {
  min-width: 0;

  .dropdown-username {
    font-size: @font-sm;
    font-weight: 600;
    color: @color-text;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dropdown-email {
    font-size: @font-xs;
    color: @color-text-tertiary;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}

/* Header 右侧按钮 */
.icon-btn {
  width: 36px;
  height: 36px;
  border: none;
  background: transparent;
  border-radius: @radius-md;
  color: @color-text-secondary;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  position: relative;
  transition: all @duration-fast;

  &:hover {
    background: @color-bg-hover;
    color: @color-text;
  }

  .badge-dot {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 8px;
    height: 8px;
    background: @color-error;
    border-radius: 50%;
    border: 2px solid @color-bg-surface;
  }
}

/* 用户 Trigger */
.user-wrapper {
  position: relative;
}

.user-trigger {
  display: flex;
  align-items: center;
  gap: @space-2;
  padding: @space-1 @space-2 @space-1 @space-1;
  border: none;
  background: transparent;
  border-radius: @radius-pill;
  cursor: pointer;
  transition: all @duration-fast;

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
  }

  .user-name {
    font-size: @font-sm;
    font-weight: 500;
    color: @color-text;
    max-width: 100px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}

/* Click outside 关闭 */
.app-header {

  &:not(:hover) .ws-dropdown,
  &:not(:hover) .user-dropdown {
    /* 简化处理，点击外部关闭需要 JS */
  }
}
</style>
