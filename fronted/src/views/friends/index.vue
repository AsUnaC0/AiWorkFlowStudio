<script setup lang="ts">
import { onMounted, ref, computed } from "vue";
import { MessagePlugin, DialogPlugin } from "tdesign-vue-next";
import {
  searchUsers,
  getFriendships,
  sendFriendRequest,
  acceptFriendRequest,
  rejectFriendRequest,
  removeFriend,
} from "@/api/friendship";
import type { FriendItem, UserSearchResult } from "@/api/friendship";

// ========== 搜索用户 ==========
const searchKeyword = ref("");
const searchResults = ref<UserSearchResult[]>([]);
const searchLoading = ref(false);
const searched = ref(false);

const debounceTimer = ref<number | null>(null);

const handleSearch = () => {
  const kw = searchKeyword.value.trim();
  if (!kw) {
    searchResults.value = [];
    searched.value = false;
    return;
  }
  if (debounceTimer.value) window.clearTimeout(debounceTimer.value);
  debounceTimer.value = window.setTimeout(async () => {
    searchLoading.value = true;
    searched.value = true;
    try {
      searchResults.value = await searchUsers(kw);
    } catch {
      MessagePlugin.error("搜索失败");
    } finally {
      searchLoading.value = false;
    }
  }, 300);
};

// ========== 好友列表 ==========
const friends = ref<FriendItem[]>([]);
const pendingReceived = ref<FriendItem[]>([]);
const pendingSent = ref<FriendItem[]>([]);
const listLoading = ref(false);
const activeTab = ref<"friends" | "received" | "sent">("friends");

const fetchFriendships = async () => {
  listLoading.value = true;
  try {
    const res = await getFriendships();
    friends.value = res.friends;
    pendingReceived.value = res.pendingReceived;
    pendingSent.value = res.pendingSent;
  } catch {
    MessagePlugin.error("好友列表加载失败");
  } finally {
    listLoading.value = false;
  }
};

const currentList = computed(() => {
  if (activeTab.value === "friends") return friends.value;
  if (activeTab.value === "received") return pendingReceived.value;
  return pendingSent.value;
});

// ========== 操作 ==========
const actionLoading = ref<string | null>(null);

const handleSendRequest = async (userId: string) => {
  actionLoading.value = userId;
  try {
    await sendFriendRequest(userId);
    MessagePlugin.success("好友请求已发送");
    // 刷新搜索结果的关系状态
    await handleSearch();
    fetchFriendships();
  } catch (e: any) {
    MessagePlugin.error(e?.response?.data?.message || "发送失败");
  } finally {
    actionLoading.value = null;
  }
};

const handleAccept = async (item: FriendItem) => {
  actionLoading.value = item.friendshipId;
  try {
    await acceptFriendRequest(item.friendshipId);
    MessagePlugin.success("已接受好友请求");
    fetchFriendships();
  } catch (e: any) {
    MessagePlugin.error(e?.response?.data?.message || "操作失败");
  } finally {
    actionLoading.value = null;
  }
};

const handleReject = async (item: FriendItem) => {
  actionLoading.value = item.friendshipId;
  try {
    await rejectFriendRequest(item.friendshipId);
    MessagePlugin.success("已拒绝");
    fetchFriendships();
  } catch (e: any) {
    MessagePlugin.error(e?.response?.data?.message || "操作失败");
  } finally {
    actionLoading.value = null;
  }
};

const handleRemoveFriend = async (item: FriendItem) => {
  const confirmDialog = DialogPlugin.confirm({
    header: "删除好友",
    body: `确定要删除与 ${item.username} 的好友关系吗？`,
    confirmBtn: { content: "删除", theme: "danger" },
    cancelBtn: { content: "取消" },
    onConfirm: async () => {
      try {
        await removeFriend(item.id);
        MessagePlugin.success("已删除好友");
        fetchFriendships();
        confirmDialog.destroy();
      } catch {
        MessagePlugin.error("删除失败");
      }
    },
  });
};

// 搜索结果中，该用户的按钮状态
const getSearchAction = (u: UserSearchResult) => {
  const fs = u.existingFriendship;
  if (!fs) return { label: "添加好友", disabled: false, variant: "primary" as const };
  if (fs.status === "ACCEPTED") return { label: "已是好友", disabled: true, variant: "default" as const };
  if (fs.status === "PENDING") {
    if (fs.isInitiator) return { label: "等待对方接受", disabled: true, variant: "default" as const };
    return { label: "等待接受", disabled: true, variant: "default" as const };
  }
  return { label: "添加好友", disabled: false, variant: "primary" as const };
};

const getInitial = (username: string) => {
  return username ? username.charAt(0).toUpperCase() : "?";
};

onMounted(() => {
  fetchFriendships();
});
</script>

<template>
  <div class="page-container">
    <div class="page-header">
      <div class="page-header-info">
        <h1 class="page-title">好友</h1>
        <p class="page-subtitle">搜索添加好友，邀请他们加入你的工作空间。</p>
      </div>
    </div>

    <!-- 搜索区 -->
    <div class="search-section">
      <div class="search-input-wrap">
        <t-icon name="search" class="search-icon" />
        <t-input
          v-model="searchKeyword"
          placeholder="按用户名或邮箱搜索用户..."
          clearable
          @input="handleSearch"
          class="search-input"
        />
      </div>

      <!-- 搜索结果 -->
      <t-loading v-if="searchLoading" text="搜索中..." :delay="200" />
      <div v-else-if="searched && searchKeyword.trim()" class="search-results">
        <div v-if="searchResults.length === 0" class="empty-hint">
          未找到匹配的用户
        </div>
        <div v-for="u in searchResults" :key="u.id" class="user-card">
          <div class="avatar">{{ getInitial(u.username) }}</div>
          <div class="user-info">
            <div class="user-name">{{ u.username }}</div>
            <div class="user-email">{{ u.email }}</div>
          </div>
          <t-button
            size="small"
            :theme="getSearchAction(u).variant === 'primary' ? 'primary' : 'default'"
            :disabled="getSearchAction(u).disabled || actionLoading === u.id"
            :loading="actionLoading === u.id"
            @click="handleSendRequest(u.id)"
          >
            {{ getSearchAction(u).label }}
          </t-button>
        </div>
      </div>
    </div>

    <!-- 好友列表 -->
    <t-loading :loading="listLoading" text="加载中..." :delay="200">
      <!-- Tab 切换 -->
      <div class="tab-bar">
        <button
          class="tab-item"
          :class="{ active: activeTab === 'friends' }"
          @click="activeTab = 'friends'"
        >
          好友
          <span class="tab-count">{{ friends.length }}</span>
        </button>
        <button
          class="tab-item"
          :class="{ active: activeTab === 'received' }"
          @click="activeTab = 'received'"
        >
          待接受
          <span v-if="pendingReceived.length > 0" class="tab-count">{{ pendingReceived.length }}</span>
        </button>
        <button
          class="tab-item"
          :class="{ active: activeTab === 'sent' }"
          @click="activeTab = 'sent'"
        >
          已发送
          <span v-if="pendingSent.length > 0" class="tab-count">{{ pendingSent.length }}</span>
        </button>
      </div>

      <!-- 列表内容 -->
      <div v-if="currentList.length > 0" class="friend-list">
        <div v-for="item in currentList" :key="item.id" class="friend-card">
          <div class="avatar">{{ getInitial(item.username) }}</div>
          <div class="friend-info">
            <div class="friend-name">
              {{ item.username }}
              <span class="status-dot" :class="item.status.toLowerCase()" />
            </div>
            <div class="friend-email">{{ item.email }}</div>
          </div>

          <!-- 操作区 -->
          <div class="friend-actions">
            <template v-if="activeTab === 'received'">
              <t-button
                size="small"
                theme="primary"
                :loading="actionLoading === item.friendshipId"
                @click="handleAccept(item)"
              >
                接受
              </t-button>
              <t-button
                size="small"
                variant="outline"
                :loading="actionLoading === item.friendshipId"
                @click="handleReject(item)"
              >
                拒绝
              </t-button>
            </template>
            <template v-else-if="activeTab === 'sent'">
              <span class="pending-hint">等待对方接受...</span>
            </template>
            <template v-else>
              <t-button
                size="small"
                variant="outline"
                theme="danger"
                :loading="actionLoading === item.friendshipId"
                @click="handleRemoveFriend(item)"
              >
                删除
              </t-button>
            </template>
          </div>
        </div>
      </div>

      <!-- 空状态 -->
      <div v-else class="empty-state">
        <div class="empty-icon">
          <t-icon name="usergroup" />
        </div>
        <h3 class="empty-title">
          {{ activeTab === "friends" ? "还没有好友" : activeTab === "received" ? "没有待接受的请求" : "没有已发送的请求" }}
        </h3>
        <p class="empty-desc">
          {{ activeTab === "friends" ? "使用上方搜索框添加好友吧" : "" }}
        </p>
      </div>
    </t-loading>
  </div>
</template>

<style scoped lang="less">
@import "../../styles/variables.less";

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: @space-8;

  .page-header-info {
    display: flex;
    flex-direction: column;
    gap: @space-1;
  }

  .page-title {
    font-size: @font-xxl;
    font-weight: 700;
    color: @color-text;
    margin: 0;
  }

  .page-subtitle {
    font-size: @font-sm;
    color: @color-text-secondary;
    margin: 0;
  }
}

/* 搜索区 */
.search-section {
  margin-bottom: @space-8;
}

.search-input-wrap {
  position: relative;
  max-width: 480px;

  .search-icon {
    position: absolute;
    left: @space-3;
    top: 50%;
    transform: translateY(-50%);
    color: @color-text-tertiary;
    font-size: 18px;
    z-index: 1;
  }

  .search-input {
    :deep(.t-input__inner) {
      padding-left: 40px;
    }
  }
}

.search-results {
  display: flex;
  flex-direction: column;
  gap: @space-2;
  margin-top: @space-4;
}

.empty-hint {
  text-align: center;
  padding: @space-8;
  color: @color-text-tertiary;
  font-size: @font-sm;
}

.user-card {
  display: flex;
  align-items: center;
  gap: @space-4;
  padding: @space-4 @space-5;
  background: @color-bg-surface;
  border: 1px solid @color-border;
  border-radius: @radius-lg;
  transition: all 180ms @ease-standard;

  &:hover {
    border-color: @color-border-strong;
    box-shadow: @shadow-sm;
  }
}

.avatar {
  width: 40px;
  height: 40px;
  border-radius: @radius-md;
  background: linear-gradient(135deg, @primary 0%, lighten(@primary, 10%) 100%);
  color: #fff;
  font-size: @font-lg;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.user-info,
.friend-info {
  flex: 1;
  min-width: 0;
}

.user-name,
.friend-name {
  font-size: @font-md;
  font-weight: 600;
  color: @color-text;
}

.user-email,
.friend-email {
  font-size: @font-sm;
  color: @color-text-secondary;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-left: @space-2;
  vertical-align: middle;

  &.online {
    background: @color-success;
  }
  &.busy {
    background: @color-warning;
  }
  &.offline {
    background: @color-text-tertiary;
    opacity: 0.5;
  }
}

/* Tab */
.tab-bar {
  display: flex;
  gap: @space-1;
  margin-bottom: @space-4;
  border-bottom: 1px solid @color-border;
}

.tab-item {
  display: flex;
  align-items: center;
  gap: @space-1;
  padding: @space-3 @space-4;
  border: none;
  background: transparent;
  font-size: @font-sm;
  font-weight: 500;
  color: @color-text-secondary;
  cursor: pointer;
  position: relative;
  transition: color @duration-fast;

  .tab-count {
    font-size: 11px;
    font-weight: 600;
    color: @primary;
    background: @primary-light;
    padding: 1px 6px;
    border-radius: @radius-pill;
  }

  &:hover {
    color: @color-text;
  }

  &.active {
    color: @primary;

    &::after {
      content: "";
      position: absolute;
      bottom: -1px;
      left: 0;
      right: 0;
      height: 2px;
      background: @primary;
      border-radius: 2px 2px 0 0;
    }
  }
}

/* 好友卡片列表 */
.friend-list {
  display: flex;
  flex-direction: column;
  gap: @space-2;
}

.friend-card {
  display: flex;
  align-items: center;
  gap: @space-4;
  padding: @space-4 @space-5;
  background: @color-bg-surface;
  border: 1px solid @color-border;
  border-radius: @radius-lg;
  transition: all 180ms @ease-standard;

  &:hover {
    border-color: @color-border-strong;
    box-shadow: @shadow-sm;
  }
}

.friend-actions {
  display: flex;
  align-items: center;
  gap: @space-2;
  flex-shrink: 0;
}

.pending-hint {
  font-size: @font-sm;
  color: @color-text-tertiary;
}

/* 空状态 */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: @space-16 @space-8;
  text-align: center;

  .empty-icon {
    width: 64px;
    height: 64px;
    border-radius: @radius-card;
    background: @color-bg-hover;
    color: @color-text-tertiary;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 28px;
    margin-bottom: @space-5;
  }

  .empty-title {
    font-size: @font-lg;
    font-weight: 600;
    color: @color-text;
    margin: 0 0 @space-2;
  }

  .empty-desc {
    font-size: @font-sm;
    color: @color-text-secondary;
    margin: 0;
  }
}
</style>
