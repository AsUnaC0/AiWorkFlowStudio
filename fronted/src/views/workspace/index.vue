<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useWorkspace } from "@/composables/useWorkspace";
import {
  getWorkflows,
  createWorkflow,
  publishWorkflow,
  archiveWorkflow,
  restoreWorkflow,
} from "@/api/workflow";
import {
  getWorkspaceMembers,
  inviteWorkspaceMember,
  removeWorkspaceMember,
  getFriendships,
} from "@/api/friendship";
import { MessagePlugin, DialogPlugin } from "tdesign-vue-next";
import type { Workflow, WorkflowDefinition, WorkflowStatus } from "@/types/workflow";
import type { FriendItem, WorkspaceMemberItem } from "@/api/friendship";
import { useUserStore } from "@/stores/user";

const route = useRoute();
const router = useRouter();

// ========== Workspace 选择视图（无 workspaceId 时显示）==========
const { workspaces, loading: wsLoading, errorMessage: wsError, fetchWorkspaces, createWorkspace, deleteWorkspace } = useWorkspace();
const createDialogVisible = ref(false);
const workspaceName = ref("");
const creating = ref(false);
const createError = ref("");

// 删除 Workspace 相关
const deleteConfirmVisible = ref(false);
const deleting = ref(false);
const targetDeleteWs = ref<{ id: string; name: string } | null>(null);

const openDeleteConfirm = (ws: { id: string; name: string }) => {
  targetDeleteWs.value = ws;
  deleteConfirmVisible.value = true;
};

const handleDeleteWorkspace = async () => {
  if (!targetDeleteWs.value) return;
  deleting.value = true;
  try {
    await deleteWorkspace(targetDeleteWs.value.id);
    deleteConfirmVisible.value = false;
    MessagePlugin.success("Workspace 已删除");
    targetDeleteWs.value = null;
  } catch {
    MessagePlugin.error("删除失败，请稍后重试");
  } finally {
    deleting.value = false;
  }
};

const openCreateDialog = () => {
  workspaceName.value = "";
  createError.value = "";
  createDialogVisible.value = true;
};

const submitCreateWorkspace = async () => {
  const name = workspaceName.value.trim();
  if (!name) {
    createError.value = "请输入 Workspace 名称";
    return;
  }
  creating.value = true;
  createError.value = "";
  try {
    await createWorkspace(name);
    createDialogVisible.value = false;
    MessagePlugin.success("Workspace 创建成功");
  } catch {
    createError.value = "创建失败，请稍后重试";
  } finally {
    creating.value = false;
  }
};

const onSelectWorkspace = async (ws: { id: string }) => {
  try {
    await router.push({ path: "/workspace", query: { workspaceId: ws.id } });
  } catch {
    wsError.value = "无法打开工作空间，请稍后重试";
  }
};

const workspaceId = computed(() => route.query.workspaceId as string | undefined);
const hasWorkspaceSelected = computed(() => !!workspaceId.value);

// ========== 工作流列表视图（有 workspaceId 时显示）==========
const workflows = ref<Workflow[]>([]);
const wfLoading = ref(false);
const wfError = ref("");
const wfCreateDialogVisible = ref(false);
const workflowName = ref("");
const wfCreating = ref(false);
const wfCreateError = ref("");

const fetchWorkflows = async () => {
  if (!workspaceId.value) return;
  wfLoading.value = true;
  wfError.value = "";
  try {
    workflows.value = await getWorkflows(workspaceId.value);
  } catch {
    wfError.value = "工作流加载失败，请稍后重试";
  } finally {
    wfLoading.value = false;
  }
};

const openWfCreateDialog = () => {
  workflowName.value = "";
  wfCreateError.value = "";
  wfCreateDialogVisible.value = true;
};

const submitCreateWorkflow = async () => {
  const name = workflowName.value.trim();
  if (!name) {
    wfCreateError.value = "请输入工作流名称";
    return;
  }
  wfCreating.value = true;
  wfCreateError.value = "";
  try {
    const defaultDef: WorkflowDefinition = {
      nodes: [
        { id: "start-1", type: "custom", position: { x: 250, y: 50 }, data: { label: "Start", nodeType: "start" } },
        { id: "output-1", type: "custom", position: { x: 250, y: 220 }, data: { label: "Output", nodeType: "output" } },
      ],
      edges: [{ id: "e-start-output", source: "start-1", target: "output-1" }],
    };
    const created = await createWorkflow(workspaceId.value!, { name, definition: defaultDef });
    wfCreateDialogVisible.value = false;
    MessagePlugin.success("工作流创建成功");
    router.push({ path: `/workspace/${created.id}` });
  } catch {
    wfCreateError.value = "创建失败，请稍后重试";
  } finally {
    wfCreating.value = false;
  }
};

const openWorkflow = (wf: Workflow) => {
  router.push({ path: `/workspace/${wf.id}` });
};

const backToWorkspaceList = () => {
  router.push({ path: "/workspace" });
};

// ========== Workspace 成员管理 ==========
const userStore = useUserStore();
const members = ref<WorkspaceMemberItem[]>([]);
const membersLoading = ref(false);
const inviteDialogVisible = ref(false);
const acceptedFriends = ref<FriendItem[]>([]);
const friendsLoading = ref(false);
const inviteLoadingId = ref<string | null>(null);

const fetchMembers = async () => {
  if (!workspaceId.value) return;
  membersLoading.value = true;
  try {
    members.value = await getWorkspaceMembers(workspaceId.value);
  } catch {
    // 非致命错误
  } finally {
    membersLoading.value = false;
  }
};

const fetchAcceptedFriends = async () => {
  friendsLoading.value = true;
  try {
    const res = await getFriendships();
    acceptedFriends.value = res.friends;
  } catch {
    MessagePlugin.error("好友列表加载失败");
  } finally {
    friendsLoading.value = false;
  }
};

const openInviteDialog = async () => {
  inviteDialogVisible.value = true;
  await fetchAcceptedFriends();
};

// 过滤掉已是成员的好友
const inviteCandidates = computed(() => {
  const memberIds = new Set(members.value.map((m) => m.userId));
  return acceptedFriends.value.filter((f) => !memberIds.has(f.id));
});

const isOwner = computed(() => {
  const owner = members.value.find((m) => m.role === "OWNER");
  return owner?.userId === userStore.userInfo?.id;
});

const handleInvite = async (friendId: string) => {
  if (!workspaceId.value) return;
  inviteLoadingId.value = friendId;
  try {
    await inviteWorkspaceMember(workspaceId.value, friendId);
    MessagePlugin.success("已邀请好友加入 Workspace");
    fetchMembers();
    fetchAcceptedFriends();
  } catch (e: any) {
    MessagePlugin.error(e?.response?.data?.message || "邀请失败");
  } finally {
    inviteLoadingId.value = null;
  }
};

const handleRemoveMember = async (member: WorkspaceMemberItem) => {
  if (!workspaceId.value) return;
  DialogPlugin.confirm({
    header: "移除成员",
    body: `确定要将 ${member.username} 从 Workspace 中移除吗？`,
    confirmBtn: { content: "移除", theme: "danger" },
    cancelBtn: { content: "取消" },
    onConfirm: async () => {
      try {
        await removeWorkspaceMember(workspaceId.value!, member.userId);
        MessagePlugin.success("已移除成员");
        fetchMembers();
      } catch (e: any) {
        MessagePlugin.error(e?.response?.data?.message || "操作失败");
      }
    },
  });
};

const getInitial = (username: string) => {
  return username ? username.charAt(0).toUpperCase() : "?";
};

// 从 workflow definition 提取节点链预览
const getNodeChain = (wf: Workflow): string[] => {
  const nodes = wf.currentVersion?.definition.nodes || [];
  if (nodes.length === 0) return ["Empty"];
  return nodes.slice(0, 4).map((n) => String(n.data?.label || n.data?.nodeType || "Node"));
};

// 相对时间
const formatRelativeTime = (dateStr: string) => {
  const date = new Date(dateStr);
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

const getStatusLabel = (status: WorkflowStatus | string) => {
  const map: Record<string, { label: string; cls: string }> = {
    DRAFT: { label: "草稿", cls: "draft" },
    PUBLISHED: { label: "已发布", cls: "published" },
    ARCHIVED: { label: "已归档", cls: "archived" },
  };
  return map[status] || { label: status, cls: "draft" };
};

// 已发布版本号显示（v1 / v2 / ...）
const getPublishedVersionLabel = (wf: Workflow): string => {
  const v = wf.publishedVersion?.version;
  return v ? `v${v}` : "";
};

// 当前草稿相对已发布版本是否有未发布改动
const hasUnpublishedChanges = (wf: Workflow): boolean => {
  // publishedVersionId 与 currentVersionId 不同 → 有改动未发布
  return wf.currentVersionId !== wf.publishedVersionId;
};

// ========== 状态切换操作（发布 / 归档 / 恢复） ==========
const actionLoadingId = ref<string | null>(null);

const handlePublish = async (wf: Workflow) => {
  actionLoadingId.value = wf.id;
  try {
    const updated = await publishWorkflow(wf.id);
    Object.assign(wf, updated);
    MessagePlugin.success(`工作流已发布 ${getPublishedVersionLabel(updated)}`);
  } catch (e: any) {
    MessagePlugin.error(e?.response?.data?.message || "发布失败");
  } finally {
    actionLoadingId.value = null;
  }
};

const handleArchive = async (wf: Workflow) => {
  actionLoadingId.value = wf.id;
  try {
    const updated = await archiveWorkflow(wf.id);
    Object.assign(wf, updated);
    MessagePlugin.success("工作流已归档");
  } catch (e: any) {
    MessagePlugin.error(e?.response?.data?.message || "归档失败");
  } finally {
    actionLoadingId.value = null;
  }
};

const handleRestore = async (wf: Workflow) => {
  actionLoadingId.value = wf.id;
  try {
    const updated = await restoreWorkflow(wf.id);
    Object.assign(wf, updated);
    MessagePlugin.success("工作流已恢复为草稿");
  } catch (e: any) {
    MessagePlugin.error(e?.response?.data?.message || "恢复失败");
  } finally {
    actionLoadingId.value = null;
  }
};

// 监听
watch(workspaceId, (id) => {
  if (id) {
    fetchWorkflows();
    fetchMembers();
  } else {
    workflows.value = [];
    members.value = [];
  }
});

onMounted(() => {
  if (!workspaceId.value) fetchWorkspaces();
  else {
    fetchWorkflows();
    fetchMembers();
  }
});

onBeforeUnmount(() => {
  workflows.value = [];
  members.value = [];
  acceptedFriends.value = [];
});
</script>

<template>
  <div class="page-container">
    <!-- ========== Workspace 选择视图 ========== -->
    <template v-if="!hasWorkspaceSelected">
      <div class="page-header">
        <div class="page-header-info">
          <h1 class="page-title">Workspaces</h1>
          <p class="page-subtitle">
            Select a workspace to manage your AI workflows and knowledge bases.
          </p>
        </div>
        <div class="page-header-actions">
          <t-button theme="primary" @click="openCreateDialog">
            <template #icon><t-icon name="add" /></template>
            New Workspace
          </t-button>
        </div>
      </div>

      <t-loading :loading="wsLoading" text="Loading..." :delay="200">
        <p v-if="wsError" class="error-message">{{ wsError }}</p>

        <div v-if="!wsLoading && !wsError && workspaces.length > 0" class="workspace-list">
          <div v-for="ws in workspaces" :key="ws.id" class="ws-row" @click="onSelectWorkspace(ws)">
            <div class="ws-icon">{{ ws.icon || "📁" }}</div>
            <div class="ws-main">
              <div class="ws-name">{{ ws.name }}</div>
              <div class="ws-desc">
                {{ ws.workflowCount }} workflows · {{ ws.knowledgeCount }} knowledge bases · {{ ws.memberCount }}
                members
              </div>
            </div>
            <button class="ws-delete-btn" @click.stop="openDeleteConfirm(ws)" title="删除 Workspace">
              <t-icon name="delete" />
            </button>
            <t-icon name="chevron-right" class="row-arrow" />
          </div>
        </div>

        <!-- Workspace 空状态 -->
        <div v-else-if="!wsLoading && !wsError && workspaces.length === 0" class="empty-state">
          <div class="empty-icon"><t-icon name="layers" /></div>
          <h3 class="empty-title">No workspaces yet</h3>
          <p class="empty-desc">Create your first workspace to get started with AI workflows.</p>
          <t-button theme="primary" @click="openCreateDialog">
            <template #icon><t-icon name="add" /></template>
            Create Workspace
          </t-button>
        </div>
      </t-loading>

      <!-- 创建 Workspace 对话框 -->
      <t-dialog v-model:visible="createDialogVisible" header="Create Workspace" :footer="false" width="420px">
        <t-form layout="vertical" @submit="submitCreateWorkspace">
          <t-form-item label="Workspace Name">
            <t-input v-model="workspaceName" placeholder="e.g. My AI Workspace" />
          </t-form-item>
          <t-alert v-if="createError" theme="error" :message="createError" class="form-alert" />
          <div class="dialog-actions">
            <t-button variant="outline" type="button" @click="createDialogVisible = false">Cancel</t-button>
            <t-button theme="primary" type="submit" :loading="creating">Create</t-button>
          </div>
        </t-form>
      </t-dialog>

      <!-- 删除 Workspace 确认对话框 -->
      <t-dialog v-model:visible="deleteConfirmVisible" header="删除 Workspace"
        :confirm-btn="{ content: '确认删除', loading: deleting, theme: 'danger' }" :cancel-btn="{ content: '取消' }"
        :close-on-overlay-click="true" @confirm="handleDeleteWorkspace">
        <p class="delete-warning">
          确定要删除 Workspace <strong>{{ targetDeleteWs?.name }}</strong> 吗？
        </p>
        <p class="delete-sub">该操作无法撤销，Workspace 中的所有工作流和知识库都将被永久删除。</p>
      </t-dialog>
    </template>

    <!-- ========== 工作流列表视图 ========== -->
    <template v-else>
      <div class="page-header">
        <div class="page-header-info">
          <div class="page-back" @click="backToWorkspaceList">
            <t-icon name="chevron-left" />
            <span>Workspaces</span>
          </div>
          <h1 class="page-title">Workflows</h1>
          <p class="page-subtitle">Build AI workflows visually. Connect nodes to create powerful automations.</p>
        </div>
        <div class="page-header-actions">
          <!-- 成员展示区 -->
          <div class="members-bar">
            <div class="members-stack">
              <t-tooltip v-for="m in members.slice(0, 5)" :key="m.userId"
                :content="`${m.username}${m.role === 'OWNER' ? ' (Owner)' : ''}`" placement="bottom">
                <div class="member-avatar" :class="{ owner: m.role === 'OWNER' }"
                  @click="m.role !== 'OWNER' && isOwner && handleRemoveMember(m)"
                  :title="isOwner && m.role !== 'OWNER' ? '点击移除' : ''">
                  {{ getInitial(m.username) }}
                </div>
              </t-tooltip>
              <t-tooltip v-if="members.length > 5" :content="`还有 ${members.length - 5} 位成员`" placement="bottom">
                <div class="member-avatar more">+{{ members.length - 5 }}</div>
              </t-tooltip>
            </div>
            <t-button theme="primary" variant="outline" size="small" @click="openInviteDialog">
              <template #icon><t-icon name="usergroup-add" /></template>
              邀请好友
            </t-button>
          </div>
          <t-button theme="primary" @click="openWfCreateDialog">
            <template #icon><t-icon name="add" /></template>
            Create Workflow
          </t-button>
        </div>
      </div>

      <t-loading :loading="wfLoading" text="Loading..." :delay="200">
        <t-alert v-if="wfError" theme="error" :message="wfError" />

        <!-- 工作流列表 -->
        <template v-else-if="workflows.length > 0">
          <div class="wf-list">
            <div v-for="wf in workflows" :key="wf.id" class="wf-row" @click="openWorkflow(wf)">
              <div class="wf-icon">
                <t-icon name="flow" />
              </div>

              <div class="wf-main">
                <div class="wf-name">{{ wf.name }}</div>
                <div class="wf-chain">
                  <template v-for="(node, idx) in getNodeChain(wf)" :key="idx">
                    <span class="chain-node">{{ node }}</span>
                    <t-icon v-if="idx < getNodeChain(wf).length - 1" name="chevron-right" class="chain-arrow" />
                  </template>
                </div>
              </div>

              <div class="wf-status">
                <span class="status-badge" :class="getStatusLabel(wf.status).cls">
                  {{ getStatusLabel(wf.status).label }}
                </span>
                <span v-if="getPublishedVersionLabel(wf)" class="version-badge">
                  {{ getPublishedVersionLabel(wf) }}
                </span>
                <span v-if="wf.status === 'PUBLISHED' && hasUnpublishedChanges(wf)" class="dirty-badge">
                  有未发布改动
                </span>
              </div>

              <div class="wf-updated">{{ formatRelativeTime(wf.updatedAt) }}</div>

              <div class="wf-row-actions">
                <!-- 状态切换按钮：根据 status 显示不同操作 -->
                <t-button v-if="wf.status === 'DRAFT' || (wf.status === 'PUBLISHED' && hasUnpublishedChanges(wf))"
                  size="small" theme="primary" variant="outline" :loading="actionLoadingId === wf.id"
                  @click.stop="handlePublish(wf)">
                  发布
                </t-button>
                <t-button v-else-if="wf.status === 'PUBLISHED'" size="small" theme="default" variant="outline"
                  :loading="actionLoadingId === wf.id" @click.stop="handleArchive(wf)">
                  归档
                </t-button>
                <t-button v-else-if="wf.status === 'ARCHIVED'" size="small" theme="default" variant="outline"
                  :loading="actionLoadingId === wf.id" @click.stop="handleRestore(wf)">
                  恢复
                </t-button>

                <button class="run-btn" @click.stop="openWorkflow(wf)" title="编辑工作流">
                  <t-icon name="edit-1" />
                </button>
                <t-icon name="chevron-right" class="row-arrow" />
              </div>
            </div>
          </div>
        </template>

        <!-- 工作流空状态 -->
        <div v-else-if="!wfLoading && !wfError" class="empty-state">
          <div class="empty-icon"><t-icon name="flow" /></div>
          <h3 class="empty-title">No workflows yet</h3>
          <p class="empty-desc">Create your first workflow to visually build AI automations.</p>
          <t-button theme="primary" @click="openWfCreateDialog">
            <template #icon><t-icon name="add" /></template>
            Create Workflow
          </t-button>
        </div>
      </t-loading>

      <!-- 创建工作流对话框 -->
      <t-dialog v-model:visible="wfCreateDialogVisible" header="Create Workflow" :footer="false" width="420px">
        <t-form layout="vertical" @submit="submitCreateWorkflow">
          <t-form-item label="Workflow Name">
            <t-input v-model="workflowName" placeholder="Customer Support AI" />
          </t-form-item>
          <t-alert v-if="wfCreateError" theme="error" :message="wfCreateError" class="form-alert" />
          <div class="dialog-actions">
            <t-button variant="outline" type="button" @click="wfCreateDialogVisible = false">Cancel</t-button>
            <t-button theme="primary" type="submit" :loading="wfCreating">Create & Edit</t-button>
          </div>
        </t-form>
      </t-dialog>

      <!-- 邀请好友对话框 -->
      <t-dialog v-model:visible="inviteDialogVisible" header="邀请好友加入 Workspace" :footer="false" width="480px">
        <div class="invite-dialog-body">
          <t-loading :loading="friendsLoading" text="加载中..." :delay="200">
            <t-alert v-if="acceptedFriends.length === 0" theme="warning" :message="'还没有已接受的好友，先去好友页面添加吧'" />

            <t-alert v-else-if="inviteCandidates.length === 0" theme="success" :message="'所有好友都已在 Workspace 中'" />

            <div v-else class="invite-list">
              <div v-for="friend in inviteCandidates" :key="friend.id" class="invite-row">
                <div class="invite-avatar">{{ getInitial(friend.username) }}</div>
                <div class="invite-info">
                  <div class="invite-name">{{ friend.username }}</div>
                  <div class="invite-email">{{ friend.email }}</div>
                </div>
                <t-button size="small" theme="primary" :loading="inviteLoadingId === friend.id"
                  @click="handleInvite(friend.id)">
                  邀请
                </t-button>
              </div>
            </div>
          </t-loading>

          <div class="dialog-actions">
            <t-button variant="outline" type="button" @click="inviteDialogVisible = false">关闭</t-button>
          </div>
        </div>
      </t-dialog>

    </template>
  </div>
</template>

<style scoped lang="less">
@import "../../styles/variables.less";

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: @space-8;
  animation: fade-slide-up @duration-normal @ease-out;

  .page-header-info {
    display: flex;
    flex-direction: column;
    gap: @space-1;
  }

  .page-back {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    font-size: @font-sm;
    color: @color-text-tertiary;
    cursor: pointer;
    padding: 4px 0;
    transition: color @duration-fast;

    &:hover {
      color: @primary;
    }
  }

  .page-title {
    font-size: @font-xxl;
    font-weight: 700;
    color: @color-text;
    letter-spacing: -0.01em;
    margin: 0;
  }

  .page-subtitle {
    font-size: @font-sm;
    color: @color-text-secondary;
    margin: 0;
  }
}

/* ========== Workspace 列表行 ========== */
.workspace-list {
  display: flex;
  flex-direction: column;
  gap: @space-2;
}

.ws-row {
  display: flex;
  align-items: center;
  gap: @space-5;
  padding: @space-5 @space-6;
  background: @color-bg-surface;
  border: 1px solid @color-border;
  border-radius: @radius-lg;
  cursor: pointer;
  transition: all 180ms @ease-standard;
  animation: fade-slide-up @duration-normal @ease-out both;

  &:hover {
    border-color: @color-border-strong;
    box-shadow: @shadow-sm;

    .ws-icon {
      background: @primary-light;
    }

    .ws-delete-btn {
      opacity: 1;
    }

    .row-arrow {
      opacity: 1;
      transform: translateX(2px);
      color: @primary;
    }
  }

  .ws-delete-btn {
    width: 32px;
    height: 32px;
    border: none;
    background: transparent;
    border-radius: @radius-md;
    color: @color-text-tertiary;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    opacity: 0;
    transition: all 180ms @ease-standard;
    flex-shrink: 0;

    &:hover {
      background: lighten(@color-error, 42%);
      color: @color-error;
    }
  }

  .ws-icon {
    width: 44px;
    height: 44px;
    border-radius: @radius-md;
    background: @color-bg-hover;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 22px;
    flex-shrink: 0;
    transition: all 180ms @ease-standard;
  }

  .ws-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .ws-name {
    font-size: @font-md;
    font-weight: 600;
    color: @color-text;
  }

  .ws-desc {
    font-size: @font-sm;
    color: @color-text-secondary;
  }
}

/* ========== Workflow 列表行 ========== */
.wf-list {
  display: flex;
  flex-direction: column;
  gap: @space-2;
}

.wf-row {
  display: flex;
  align-items: center;
  gap: @space-5;
  padding: @space-5 @space-6;
  background: @color-bg-surface;
  border: 1px solid @color-border;
  border-radius: @radius-lg;
  cursor: pointer;
  transition: all 180ms @ease-standard;
  animation: fade-slide-up @duration-normal @ease-out both;

  &:hover {
    border-color: @color-border-strong;
    box-shadow: @shadow-sm;

    .wf-icon {
      background: @primary-light;
      color: @primary;
    }

    .run-btn {
      opacity: 1;
    }

    .row-arrow {
      opacity: 1;
      transform: translateX(2px);
      color: @primary;
    }

    .chain-node {
      color: @primary;
    }

    .chain-arrow {
      color: @primary;
    }
  }

  .wf-icon {
    width: 44px;
    height: 44px;
    border-radius: @radius-md;
    background: @color-bg-hover;
    color: @color-text-secondary;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    flex-shrink: 0;
    transition: all 180ms @ease-standard;
  }

  .wf-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: @space-2;
  }

  .wf-name {
    font-size: @font-md;
    font-weight: 600;
    color: @color-text;
  }

  .wf-chain {
    display: flex;
    align-items: center;
    gap: @space-1;
    flex-wrap: wrap;

    .chain-node {
      font-size: @font-xs;
      font-weight: 500;
      color: @color-text-secondary;
      transition: color 180ms @ease-standard;
    }

    .chain-arrow {
      font-size: 10px;
      color: @color-text-tertiary;
    }
  }

  .wf-status {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;

    .status-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 2px @space-2;
      border-radius: @radius-pill;
      text-transform: uppercase;
      letter-spacing: 0.03em;

      &.draft {
        background: @color-bg-hover;
        color: @color-text-secondary;
      }

      &.published {
        background: lighten(@color-success, 40%);
        color: @color-success;
      }

      &.archived {
        background: lighten(@color-text-tertiary, 30%);
        color: @color-text-tertiary;
      }
    }

    .version-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: @radius-pill;
      background: lighten(@primary, 35%);
      color: @primary;
      font-family: "Menlo", "Consolas", monospace;
    }

    .dirty-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: @radius-pill;
      background: lighten(@color-warning, 40%);
      color: @color-warning;
    }
  }

  .wf-updated {
    font-size: @font-xs;
    color: @color-text-tertiary;
    flex-shrink: 0;
  }

  .wf-row-actions {
    display: flex;
    align-items: center;
    gap: @space-2;
    flex-shrink: 0;

    .run-btn {
      width: 32px;
      height: 32px;
      border: none;
      background: @primary;
      color: #fff;
      border-radius: @radius-md;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      opacity: 0;
      transform: scale(0.9);
      transition: all 180ms @ease-standard;

      &:hover {
        background: @primary-hover;
      }
    }
  }
}

/* 通用：右侧箭头 */
.row-arrow {
  color: @color-text-tertiary;
  opacity: 0;
  transform: translateX(-2px);
  transition: all 180ms @ease-standard;
  font-size: 16px;
}

/* ========== 空状态 ========== */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: @space-16 @space-8;
  text-align: center;
  animation: fade-slide-up @duration-normal @ease-out;

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
    max-width: 360px;
    margin: 0 0 @space-6;
  }
}

/* ========== 删除确认对话框 ========== */
.delete-warning {
  font-size: @font-md;
  color: @color-text;
  margin: 0 0 @space-2;

  strong {
    color: @color-error;
  }
}

.delete-sub {
  font-size: @font-sm;
  color: @color-text-tertiary;
  margin: 0;
}

/* ========== 成员展示区 ========== */
.page-header-actions {
  display: flex;
  align-items: center;
  gap: @space-3;
  flex-shrink: 0;
}

.members-bar {
  display: flex;
  align-items: center;
  gap: @space-3;
  padding: @space-2 @space-3;
  background: @color-bg-surface;
  border: 1px solid @color-border;
  border-radius: @radius-lg;
}

.members-stack {
  display: flex;
  align-items: center;
}

.member-avatar {
  width: 32px;
  height: 32px;
  border-radius: @radius-md;
  background: @color-bg-hover;
  color: @color-text-secondary;
  font-size: @font-sm;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-left: -8px;
  border: 2px solid @color-bg-surface;
  transition: all 180ms @ease-standard;
  cursor: default;

  &:first-child {
    margin-left: 0;
  }

  &.owner {
    background: linear-gradient(135deg, @primary 0%, lighten(@primary, 10%) 100%);
    color: #fff;
  }

  &.more {
    background: @color-bg-hover;
    color: @color-text-tertiary;
    font-size: 10px;
  }

  &:hover {
    transform: translateY(-2px);
    box-shadow: @shadow-sm;
  }
}

/* ========== 邀请对话框 ========== */
.invite-dialog-body {
  display: flex;
  flex-direction: column;
  gap: @space-4;
}

.invite-list {
  display: flex;
  flex-direction: column;
  gap: @space-2;
  max-height: 320px;
  overflow-y: auto;
}

.invite-row {
  display: flex;
  align-items: center;
  gap: @space-3;
  padding: @space-3;
  background: @color-bg-surface;
  border: 1px solid @color-border;
  border-radius: @radius-md;
  transition: all 180ms @ease-standard;

  &:hover {
    border-color: @color-border-strong;
    box-shadow: @shadow-sm;
  }
}

.invite-avatar {
  width: 36px;
  height: 36px;
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

.invite-info {
  flex: 1;
  min-width: 0;
}

.invite-name {
  font-size: @font-md;
  font-weight: 600;
  color: @color-text;
}

.invite-email {
  font-size: @font-sm;
  color: @color-text-secondary;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: @space-2;
  margin-top: @space-4;
}
</style>
