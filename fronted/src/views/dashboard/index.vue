<script setup lang="ts">
import { ref } from "vue";
import { useWorkspace } from "@/composables/useWorkspace";

const { workspaces, loading, errorMessage, createWorkspace, selectWorkspace } =
  useWorkspace();
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
  } catch {
    createError.value = "创建失败，请稍后重试";
  } finally {
    creating.value = false;
  }
};
</script>

<template>
  <div class="dashboard-container">
    <header class="dashboard-header">
      <h1 class="page-title">我的 Workspace</h1>
    </header>

    <main class="dashboard-content" v-if="!loading">
      <p v-if="errorMessage" class="error-message">{{ errorMessage }}</p>
      <!-- Workspace 卡片列表网格布局 -->
      <div class="workspace-grid">
        <div
          v-for="ws in workspaces"
          :key="ws.id"
          class="workspace-card"
          @click="selectWorkspace(ws)"
        >
          <div class="card-header">
            <span class="card-icon">{{ ws.icon || "📁" }}</span>
            <h2 class="card-title">{{ ws.name }}</h2>
          </div>
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
        </div>
      </div>

      <!-- 操作区域 -->
      <div class="action-bar">
        <button class="btn-create-workspace" @click="openCreateDialog">
          <span class="plus-icon">+</span> 创建 Workspace
        </button>
      </div>
    </main>

    <t-dialog
      v-model:visible="createDialogVisible"
      header="创建 Workspace"
      :footer="false"
      width="420px"
    >
      <form class="create-form" @submit.prevent="submitCreateWorkspace">
        <label class="create-label" for="workspace-name">Workspace 名称</label>
        <t-input
          id="workspace-name"
          v-model="workspaceName"
          placeholder="请输入 Workspace 名称"
          autofocus
        />
        <p v-if="createError" class="error-message">{{ createError }}</p>
        <div class="dialog-actions">
          <t-button
            variant="outline"
            type="button"
            @click="createDialogVisible = false"
          >
            取消
          </t-button>
          <t-button theme="primary" type="submit" :loading="creating">
            创建
          </t-button>
        </div>
      </form>
    </t-dialog>
  </div>
</template>

<style lang="less" scoped>
// 定义 Less 变量
@primary-color: #0052d9;
@primary-hover: #0034b5;
@bg-color: #f3f4f7;
@card-bg: #ffffff;
@text-main: #1d1d1f;
@text-secondary: #86909c;
@border-color: #e5e6eb;
@radius-base: 8px;
@shadow-base: 0 4px 12px rgba(0, 0, 0, 0.05);
@shadow-hover: 0 8px 24px rgba(0, 0, 0, 0.1);

.dashboard-container {
  min-height: 100vh;
  padding: 32px;
  background-color: @bg-color;
  box-sizing: border-box;

  .dashboard-header {
    margin-bottom: 24px;

    .page-title {
      font-size: 24px;
      font-weight: 600;
      color: @text-main;
      margin: 0;
    }
  }

  .dashboard-content {
    display: flex;
    flex-direction: column;
    gap: 32px;

    .error-message {
      margin: 0;
      color: #d54941;
      font-size: 13px;
    }
  }

  .create-form {
    display: flex;
    flex-direction: column;
    gap: 12px;

    .create-label {
      color: @text-main;
      font-size: 14px;
      font-weight: 600;
    }

    .error-message {
      margin: 0;
      color: #d54941;
      font-size: 13px;
    }

    .dialog-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 8px;
    }
  }

  .workspace-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 20px;
  }

  .workspace-card {
    background-color: @card-bg;
    border: 1px solid @border-color;
    border-radius: @radius-base;
    padding: 20px;
    cursor: pointer;
    transition: all 0.25s ease;
    display: flex;
    flex-direction: column;
    justify-content: space-between;

    &:hover {
      transform: translateY(-2px);
      box-shadow: @shadow-hover;
      border-color: lighten(@primary-color, 30%);
    }

    .card-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid fade(@border-color, 60%);

      .card-icon {
        font-size: 20px;
      }

      .card-title {
        font-size: 16px;
        font-weight: 600;
        color: @text-main;
        margin: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    }

    .card-body {
      display: flex;
      flex-direction: column;
      gap: 8px;

      .stat-item {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 14px;

        .stat-value {
          font-weight: 600;
          color: @text-main;
          min-width: 20px;
        }

        .stat-label {
          color: @text-secondary;
        }
      }
    }
  }

  .action-bar {
    display: flex;
    justify-content: flex-start;

    .btn-create-workspace {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 10px 24px;
      font-size: 14px;
      font-weight: 500;
      color: #ffffff;
      background-color: @primary-color;
      border: none;
      border-radius: @radius-base;
      cursor: pointer;
      transition:
        background-color 0.2s ease,
        transform 0.1s ease;

      .plus-icon {
        font-size: 16px;
        line-height: 1;
      }

      &:hover {
        background-color: @primary-hover;
      }

      &:active {
        transform: scale(0.98);
      }
    }
  }
}
</style>
