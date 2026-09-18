<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useWorkspace } from "@/composables/useWorkspace";
import { getWorkflows, createWorkflow } from "@/api/workflow";
import { MessagePlugin } from "tdesign-vue-next";
import type { Workflow, WorkflowDefinition } from "@/types/workflow";

const route = useRoute();
const router = useRouter();

// 当前选中的 Workspace ID（从 query 获取）
const workspaceId = computed(() => route.query.workspaceId as string | undefined);

// 是否选中了某个 Workspace（决定显示 workspace 选择还是工作流列表）
const hasWorkspaceSelected = computed(() => !!workspaceId.value);

// ========== Workspace 选择视图（无 workspaceId 时显示）==========
const { workspaces, loading: wsLoading, errorMessage: wsError, fetchWorkspaces, createWorkspace } = useWorkspace();
const createDialogVisible = ref(false);
const workspaceName = ref("");
const creating = ref(false);
const createError = ref("");

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

// 覆写 selectWorkspace，直接在本页面切换视图
const onSelectWorkspace = async (ws: { id: string }) => {
  try {
    await router.push({
      path: "/workflow",
      query: { workspaceId: ws.id },
    });
  } catch {
    wsError.value = "无法打开工作空间，请稍后重试";
  }
};

// 事件处理：通过 event 获取 workspace
const handleWorkspaceClick = (e: MouseEvent) => {
  const target = e.currentTarget as HTMLElement;
  const id: string = target.dataset.id || "";
  const list = workspaces.value as unknown as { id: string }[];
  const ws = list.find((w) => w.id === id);
  if (ws) onSelectWorkspace(ws);
};

// ========== 工作流列表视图（有 workspaceId 时显示）==========
const activeTab = ref<string>("workflow");
const workflows = ref<Workflow[]>([]);
const wfLoading = ref(false);
const wfError = ref("");

const wfCreateDialogVisible = ref(false);
const workflowName = ref("");
const wfCreating = ref(false);
const wfCreateError = ref("");

const showCreateButton = computed(() => activeTab.value === "workflow");
const createButtonText = computed(() => {
  if (activeTab.value === "workflow") return "+ 创建工作流";
  if (activeTab.value === "knowledge") return "+ 创建知识库（开发中）";
  return "+ 创建 Agent（开发中）";
});

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
  if (activeTab.value !== "workflow") return;
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
        {
          id: "start-1",
          type: "custom",
          position: { x: 250, y: 50 },
          data: { label: "Start", nodeType: "start" },
        },
        {
          id: "output-1",
          type: "custom",
          position: { x: 250, y: 220 },
          data: { label: "Output", nodeType: "output" },
        },
      ],
      edges: [{ id: "e-start-output", source: "start-1", target: "output-1" }],
    };

    const created = await createWorkflow(workspaceId.value!, {
      name,
      definition: defaultDef,
    });
    wfCreateDialogVisible.value = false;
    MessagePlugin.success("工作流创建成功");
    router.push({ path: `/workflow/${created.id}` });
  } catch {
    wfCreateError.value = "创建失败，请稍后重试";
  } finally {
    wfCreating.value = false;
  }
};

const openWorkflow = (workflow: Workflow) => {
  router.push({ path: `/workflow/${workflow.id}` });
};

// 事件处理：通过 event 获取 workflow
const handleWorkflowClick = (e: MouseEvent) => {
  const target = e.currentTarget as HTMLElement;
  const id: string = target.dataset.id || "";
  const list = workflows.value as unknown as Workflow[];
  const wf = list.find((w) => w.id === id);
  if (wf) openWorkflow(wf);
};

const formatDate = (dateStr: string) => {
  const d = new Date(dateStr);
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};

// 返回 Workspace 选择视图
const backToWorkspaceList = () => {
  router.push({ path: "/workflow" });
};

// 监听 workspaceId 变化，加载工作流
watch(workspaceId, (id) => {
  if (id) {
    fetchWorkflows();
  } else {
    workflows.value = [];
    activeTab.value = "workflow";
  }
});

watch(activeTab, (val) => {
  if (val === "workflow" && workspaceId.value) {
    fetchWorkflows();
  }
});

onMounted(() => {
  // 如果没有 workspaceId，需要手动触发 workspace 列表加载
  // useWorkspace 的 onMounted 会自动执行，但当从工作流视图返回时需要手动刷新
  if (!workspaceId.value) {
    fetchWorkspaces();
  }
});

onBeforeUnmount(() => {
  workflows.value = [];
});
</script>

<template>
  <div class="workflow-page">
    <!-- ========== Workspace 选择视图 ========== -->
    <template v-if="!hasWorkspaceSelected">
      <div class="page-toolbar">
        <span class="page-title">工作空间</span>
        <div class="toolbar-actions">
          <t-button theme="primary" @click="openCreateDialog">
            <template #icon><t-icon name="add" /></template>
            创建 Workspace
          </t-button>
        </div>
      </div>

      <t-loading :loading="wsLoading" text="正在加载 Workspace..." :delay="200">
        <p v-if="wsError" class="error-message">{{ wsError }}</p>

        <div v-if="!wsLoading && !wsError" class="workspace-grid">
          <div v-for="ws in workspaces" :key="ws.id" class="workspace-card-wrapper" :data-id="ws.id"
            @click="handleWorkspaceClick">
            <t-card class="workspace-card" :bordered="true" size="medium">
              <template #header>
                <div class="card-header">
                  <span class="card-icon">{{ ws.icon || "📁" }}</span>
                  <span class="card-title">{{ ws.name }}</span>
                </div>
              </template>
              <div class="card-body">
                <div class="stat-item">
                  <span class="stat-value">{{ ws.workflowCount }}</span>
                  <span class="stat-label">个 Workflow</span>
                </div>
                <div class="stat-item">
                  <span class="stat-value">{{ ws.knowledgeCount }}</span>
                  <span class="stat-label">个知识库</span>
                </div>
                <div class="stat-item">
                  <span class="stat-value">{{ ws.reportCount }}</span>
                  <span class="stat-label">份 AI 报告</span>
                </div>
                <div class="stat-item">
                  <span class="stat-value">{{ ws.memberCount }}</span>
                  <span class="stat-label">名成员</span>
                </div>
              </div>
            </t-card>
          </div>
        </div>

        <t-empty v-if="!wsLoading && !wsError && workspaces.length === 0" type="empty" title="还没有 Workspace"
          description="点击上方按钮创建第一个 Workspace 吧">
          <template #action>
            <t-button theme="primary" @click="openCreateDialog">
              创建 Workspace
            </t-button>
          </template>
        </t-empty>
      </t-loading>

      <!-- 创建 Workspace 对话框 -->
      <t-dialog v-model:visible="createDialogVisible" header="创建 Workspace" :footer="false" width="420px">
        <t-form layout="vertical" @submit.prevent="submitCreateWorkspace">
          <t-form-item label="Workspace 名称">
            <t-input v-model="workspaceName" placeholder="请输入 Workspace 名称" />
          </t-form-item>
          <t-alert v-if="createError" theme="error" :message="createError" class="form-alert" />
          <div class="dialog-actions">
            <t-button variant="outline" type="button" @click="createDialogVisible = false">
              取消
            </t-button>
            <t-button theme="primary" type="submit" :loading="creating">
              创建
            </t-button>
          </div>
        </t-form>
      </t-dialog>
    </template>

    <!-- ========== 工作流列表视图 ========== -->
    <template v-else>
      <div class="page-toolbar">
        <div class="toolbar-left">
          <t-button variant="text" @click="backToWorkspaceList">
            <template #icon><t-icon name="chevron-left" /></template>
            返回
          </t-button>
          <span class="page-title">工作空间</span>
        </div>
        <div class="toolbar-actions">
          <t-button v-if="showCreateButton" theme="primary" @click="openWfCreateDialog">
            {{ createButtonText }}
          </t-button>
          <t-tooltip v-else content="功能开发中" placement="bottom">
            <t-button disabled>{{ createButtonText }}</t-button>
          </t-tooltip>
        </div>
      </div>

      <t-tabs v-model="activeTab" class="main-tabs">
        <!-- 工作流 Tab -->
        <t-tab-panel value="workflow" label="工作流">
          <t-loading :loading="wfLoading" text="正在加载工作流..." :delay="200">
            <div class="list-content">
              <t-alert v-if="wfError" theme="error" :message="wfError" />

              <template v-else-if="workflows.length > 0">
                <div class="workflow-grid">
                  <div v-for="wf in workflows" :key="wf.id" class="workflow-card-wrapper" :data-id="wf.id"
                    @click="handleWorkflowClick">
                    <t-card class="workflow-card" :bordered="true" :title="wf.name">
                      <div class="card-footer">
                        <span class="meta-label">创建于 {{ formatDate(wf.createdAt) }}</span>
                        <span class="meta-label">更新于 {{ formatDate(wf.updatedAt) }}</span>
                      </div>
                    </t-card>
                  </div>
                </div>
              </template>

              <t-empty v-else type="empty" title="还没有工作流" description="点击上方按钮创建第一个工作流吧">
                <template #action>
                  <t-button theme="primary" @click="openWfCreateDialog">
                    创建工作流
                  </t-button>
                </template>
              </t-empty>
            </div>
          </t-loading>
        </t-tab-panel>

        <!-- 知识库 Tab -->
        <t-tab-panel value="knowledge" label="知识库">
          <div class="tab-placeholder">
            <t-empty type="maintenance" title="知识库功能开发中" description="知识库 API 接口尚未对接，敬请期待" />
          </div>
        </t-tab-panel>

        <!-- Agent Tab -->
        <t-tab-panel value="agent" label="Agent">
          <div class="tab-placeholder">
            <t-empty type="maintenance" title="Agent 功能开发中" description="Agent API 接口尚未对接，敬请期待" />
          </div>
        </t-tab-panel>
      </t-tabs>

      <!-- 创建工作流对话框 -->
      <t-dialog v-model:visible="wfCreateDialogVisible" header="创建工作流" :footer="false" width="420px">
        <t-form layout="vertical" @submit.prevent="submitCreateWorkflow">
          <t-form-item label="工作流名称">
            <t-input v-model="workflowName" placeholder="请输入工作流名称" />
          </t-form-item>
          <t-alert v-if="wfCreateError" theme="error" :message="wfCreateError" class="form-alert" />
          <div class="dialog-actions">
            <t-button variant="outline" type="button" @click="wfCreateDialogVisible = false">
              取消
            </t-button>
            <t-button theme="primary" type="submit" :loading="wfCreating">
              创建并进入编辑
            </t-button>
          </div>
        </t-form>
      </t-dialog>
    </template>
  </div>
</template>

<style scoped>
.workflow-page {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  padding: var(--space-4) var(--space-8) var(--space-8);
  box-sizing: border-box;
}

.page-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) 0 var(--space-4);
  flex-shrink: 0;

  .toolbar-left {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .page-title {
    font-size: var(--font-xl);
    font-weight: 600;
    color: var(--color-text);
  }

  .toolbar-actions {
    display: flex;
    gap: var(--space-2);
  }
}

.error-message {
  margin: 0;
  color: var(--color-error);
  font-size: var(--font-sm);
}

/* Workspace 卡片网格 */
.workspace-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--space-5);
}

.workspace-card-wrapper {
  cursor: pointer;
  transition: transform 0.2s ease;

  &:hover {
    transform: translateY(-2px);
  }
}

.workspace-card {
  .card-header {
    display: flex;
    align-items: center;
    gap: var(--space-3);

    .card-icon {
      font-size: var(--font-xxl);
    }

    .card-title {
      font-size: var(--font-lg);
      font-weight: 600;
      color: var(--color-text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }

  .card-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);

    .stat-item {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      font-size: var(--font-base);

      .stat-value {
        font-weight: 600;
        color: var(--color-text);
        min-width: 20px;
      }

      .stat-label {
        color: var(--color-text-tertiary);
      }
    }
  }
}

/* 工作流 Tab 区域 */
.main-tabs {
  flex: 1;
  background: var(--color-bg-card);
  border-radius: var(--radius-lg);
  padding: 0 var(--space-5) var(--space-5);
  min-height: 0;
}

.list-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding-top: var(--space-4);
}

.tab-placeholder {
  display: flex;
  justify-content: center;
  padding: 60px var(--space-5);
  padding-top: var(--space-8);
}

.workflow-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--space-4);
}

.workflow-card-wrapper {
  cursor: pointer;
  transition: transform 0.2s ease;

  &:hover {
    transform: translateY(-2px);
  }
}

.workflow-card {

  .card-footer {
    display: flex;
    gap: 12px;

    .meta-label {
      font-size: var(--font-xs);
      color: var(--color-text-tertiary);
    }
  }
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.form-alert {
  margin-bottom: 4px;
}
</style>
