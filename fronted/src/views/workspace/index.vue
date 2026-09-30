<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useWorkspace } from "@/composables/useWorkspace";
import { getWorkflows, createWorkflow } from "@/api/workflow";
import { MessagePlugin } from "tdesign-vue-next";
import type { Workflow, WorkflowDefinition } from "@/types/workflow";

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

const getStatusLabel = (status: string) => {
  const map: Record<string, { label: string; cls: string }> = {
    draft: { label: "Draft", cls: "draft" },
    published: { label: "Published", cls: "published" },
    running: { label: "Running", cls: "running" },
  };
  return map[status] || { label: status, cls: "draft" };
};

// 监听
watch(workspaceId, (id) => {
  if (id) fetchWorkflows();
  else workflows.value = [];
});

onMounted(() => {
  if (!workspaceId.value) fetchWorkspaces();
});

onBeforeUnmount(() => {
  workflows.value = [];
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
              </div>

              <div class="wf-updated">{{ formatRelativeTime(wf.updatedAt) }}</div>

              <div class="wf-row-actions">
                <button class="run-btn" @click.stop="openWorkflow(wf)">
                  <t-icon name="play" />
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

      &.running {
        background: @primary-light;
        color: @primary;
      }
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
</style>
