<script setup lang="ts">
import { onMounted, ref } from "vue";
import {
  createMcpServer,
  getMcpServers,
  updateMcpServer,
  removeMcpServer,
  testMcpConnection,
} from "@/api/mcp";
import { MessagePlugin } from "tdesign-vue-next";
import type { McpServer, TestConnectionResult } from "@/types/mcp";

// ========== MCP Server 列表 ==========
const servers = ref<McpServer[]>([]);
const serversLoading = ref(false);
const serversError = ref("");

const fetchServers = async () => {
  serversLoading.value = true;
  serversError.value = "";
  try {
    servers.value = await getMcpServers();
  } catch {
    serversError.value = "MCP Servers 加载失败，请稍后重试";
  } finally {
    serversLoading.value = false;
  }
};

// ========== 创建 / 编辑 ==========
const createDialogVisible = ref(false);
const editingServer = ref<McpServer | null>(null);
const formSaving = ref(false);
const formError = ref("");

const formData = ref({
  name: "",
  description: "",
  transport: "STREAMABLE_HTTP" as "SSE" | "STREAMABLE_HTTP",
  serverUrl: "",
  authType: "NONE" as "NONE" | "API_KEY" | "BEARER_TOKEN",
  apiKey: "",
  bearerToken: "",
});

const resetForm = () => {
  formData.value = {
    name: "",
    description: "",
    transport: "STREAMABLE_HTTP",
    serverUrl: "",
    authType: "NONE",
    apiKey: "",
    bearerToken: "",
  };
  formError.value = "";
};

const openCreateDialog = () => {
  editingServer.value = null;
  resetForm();
  createDialogVisible.value = true;
};

const openEditDialog = (server: McpServer) => {
  editingServer.value = server;
  formData.value = {
    name: server.name,
    description: server.description || "",
    transport: server.transport,
    serverUrl: server.serverUrl,
    authType: server.authType,
    apiKey: "",
    bearerToken: "",
  };
  formError.value = "";
  createDialogVisible.value = true;
};

const submitForm = async () => {
  const name = formData.value.name.trim();
  if (!name) {
    formError.value = "请输入 MCP Server 名称";
    return;
  }
  const url = formData.value.serverUrl.trim();
  if (!url) {
    formError.value = "请输入 Server URL";
    return;
  }

  formSaving.value = true;
  formError.value = "";
  try {
    const payload = {
      name,
      description: formData.value.description.trim() || undefined,
      transport: formData.value.transport,
      serverUrl: url,
      authType: formData.value.authType,
      apiKey: formData.value.apiKey || undefined,
      bearerToken: formData.value.bearerToken || undefined,
    };

    if (editingServer.value) {
      await updateMcpServer(editingServer.value.id, payload);
      MessagePlugin.success("MCP Server 更新成功");
    } else {
      await createMcpServer(payload);
      MessagePlugin.success("MCP Server 创建成功");
    }
    createDialogVisible.value = false;
    fetchServers();
  } catch {
    formError.value = editingServer.value ? "更新失败，请稍后重试" : "创建失败，请稍后重试";
  } finally {
    formSaving.value = false;
  }
};

// ========== 删除 ==========
const deleteTarget = ref<McpServer | null>(null);
const deleteDialogVisible = ref(false);
const deleting = ref(false);

const openDeleteDialog = (server: McpServer) => {
  deleteTarget.value = server;
  deleteDialogVisible.value = true;
};

const submitDelete = async () => {
  if (!deleteTarget.value) return;
  deleting.value = true;
  try {
    await removeMcpServer(deleteTarget.value.id);
    deleteDialogVisible.value = false;
    MessagePlugin.success("MCP Server 已删除");
    fetchServers();
  } catch {
    MessagePlugin.error("删除失败，请稍后重试");
  } finally {
    deleting.value = false;
  }
};

// ========== 测试连接 ==========
const testingId = ref<string | null>(null);

const handleTestConnection = async (server: McpServer) => {
  testingId.value = server.id;
  try {
    const result: TestConnectionResult = await testMcpConnection(server.id);
    if (result.success) {
      MessagePlugin.success(result.message);
    } else {
      MessagePlugin.error(result.message);
    }
    fetchServers();
  } catch {
    MessagePlugin.error("连接测试失败");
    fetchServers();
  } finally {
    testingId.value = null;
  }
};

// ========== 工具函数 ==========
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

const getStatusInfo = (server: McpServer) => {
  switch (server.status) {
    case "CONNECTED":
      return { label: "Connected", cls: "connected" };
    case "ERROR":
      return { label: "Error", cls: "error" };
    default:
      return { label: "Disconnected", cls: "disconnected" };
  }
};

const getToolCount = (server: McpServer): number => {
  if (!server.availableTools || !Array.isArray(server.availableTools)) return 0;
  return server.availableTools.length;
};

const getTransportLabel = (transport: string) => {
  return transport === "SSE" ? "SSE" : "HTTP";
};

onMounted(() => {
  fetchServers();
});
</script>

<template>
  <div class="page-container">
    <!-- 页面头部 -->
    <div class="page-header">
      <div class="page-header-info">
        <h1 class="page-title">MCP Servers</h1>
        <p class="page-subtitle">
          Connect external tools via MCP. Your Agent or LLM node can call GitHub, databases, web search, and more.
        </p>
      </div>
      <div class="page-header-actions">
        <t-button theme="primary" @click="openCreateDialog">
          <template #icon><t-icon name="add" /></template>
          Add MCP Server
        </t-button>
      </div>
    </div>

    <!-- 内容 -->
    <t-loading :loading="serversLoading" text="Loading..." :delay="200">
      <t-alert v-if="serversError" theme="error" :message="serversError" style="margin-top: var(--space-4)" />

      <!-- Server 列表 -->
      <template v-else-if="servers.length > 0">
        <div class="server-list">
          <div
            v-for="server in servers"
            :key="server.id"
            class="server-row"
          >
            <!-- 图标 -->
            <div class="server-icon" :class="getStatusInfo(server).cls">
              <t-icon name="plugin" />
            </div>

            <!-- 主信息 -->
            <div class="server-main" @click="openEditDialog(server)">
              <div class="server-name">{{ server.name }}</div>
              <div class="server-url">{{ server.serverUrl }}</div>
              <div v-if="server.description" class="server-desc">
                {{ server.description }}
              </div>
            </div>

            <!-- 状态 -->
            <div class="server-status">
              <span class="status-dot" :class="getStatusInfo(server).cls" />
              <span class="status-text" :class="getStatusInfo(server).cls">
                {{ getStatusInfo(server).label }}
              </span>
            </div>

            <!-- Tools 数量 -->
            <div class="server-tools">
              <span class="tool-count">{{ getToolCount(server) }}</span>
              <span class="tool-label">tools</span>
            </div>

            <!-- 传输方式 -->
            <div class="server-transport">
              <span class="transport-badge">{{ getTransportLabel(server.transport) }}</span>
            </div>

            <!-- 时间 -->
            <div class="server-updated">{{ formatRelativeTime(server.updatedAt) }}</div>

            <!-- 操作 -->
            <div class="server-row-actions">
              <t-button
                size="small"
                theme="primary"
                variant="outline"
                :loading="testingId === server.id"
                @click.stop="handleTestConnection(server)"
              >
                Test
              </t-button>
              <t-dropdown @click.stop>
                <button class="row-more-btn" @click.stop>
                  <t-icon name="more" />
                </button>
                <template #dropdown>
                  <t-dropdown-menu>
                    <t-dropdown-item @click.stop="openEditDialog(server)">
                      <template #prefix><t-icon name="edit-1" /></template>
                      Edit
                    </t-dropdown-item>
                    <t-dropdown-item @click.stop="openDeleteDialog(server)">
                      <template #prefix><t-icon name="delete" /></template>
                      Delete
                    </t-dropdown-item>
                  </t-dropdown-menu>
                </template>
              </t-dropdown>
            </div>
          </div>
        </div>
      </template>

      <!-- 空状态 -->
      <div v-else-if="!serversLoading && !serversError" class="empty-state">
        <div class="empty-icon"><t-icon name="plugin" /></div>
        <h3 class="empty-title">No MCP servers yet</h3>
        <p class="empty-desc">
          Add your first MCP server to give your Agent access to external tools like GitHub, databases, and web search.
        </p>
        <t-button theme="primary" @click="openCreateDialog">
          <template #icon><t-icon name="add" /></template>
          Add MCP Server
        </t-button>
      </div>
    </t-loading>

    <!-- 创建 / 编辑 对话框 -->
    <t-dialog
      v-model:visible="createDialogVisible"
      :header="editingServer ? 'Edit MCP Server' : 'Add MCP Server'"
      :footer="false"
      width="560px"
    >
      <t-form layout="vertical" @submit="submitForm">
        <t-form-item label="Name">
          <t-input v-model="formData.name" placeholder="GitHub MCP" maxlength="200" />
        </t-form-item>
        <t-form-item label="Description (optional)">
          <t-textarea
            v-model="formData.description"
            placeholder="GitHub repository management tool"
            :maxlength="1000"
            :autosize="{ minRows: 2, maxRows: 4 }"
          />
        </t-form-item>
        <t-form-item label="Transport">
          <t-radio-group v-model="formData.transport">
            <t-radio value="STREAMABLE_HTTP">Streamable HTTP</t-radio>
            <t-radio value="SSE">SSE</t-radio>
          </t-radio-group>
        </t-form-item>
        <t-form-item label="Server URL">
          <t-input v-model="formData.serverUrl" placeholder="https://example.com/mcp" />
        </t-form-item>
        <t-form-item label="Authentication">
          <t-select v-model="formData.authType" :style="{ width: '200px' }">
            <t-option value="NONE" label="None" />
            <t-option value="API_KEY" label="API Key" />
            <t-option value="BEARER_TOKEN" label="Bearer Token" />
          </t-select>
        </t-form-item>
        <t-form-item v-if="formData.authType === 'API_KEY'" label="API Key">
          <t-input
            v-model="formData.apiKey"
            type="password"
            :placeholder="editingServer ? 'Enter new key to update' : 'Your API key'"
          />
        </t-form-item>
        <t-form-item v-if="formData.authType === 'BEARER_TOKEN'" label="Bearer Token">
          <t-input
            v-model="formData.bearerToken"
            type="password"
            :placeholder="editingServer ? 'Enter new token to update' : 'Your bearer token'"
          />
        </t-form-item>
        <t-alert v-if="formError" theme="error" :message="formError" class="form-alert" />
        <div class="dialog-actions">
          <t-button variant="outline" type="button" @click="createDialogVisible = false">
            Cancel
          </t-button>
          <t-button theme="primary" type="submit" :loading="formSaving">
            {{ editingServer ? 'Save' : 'Add' }}
          </t-button>
        </div>
      </t-form>
    </t-dialog>

    <!-- 删除确认 -->
    <t-dialog
      v-model:visible="deleteDialogVisible"
      header="Delete MCP Server"
      :footer="false"
      width="420px"
    >
      <p class="delete-tip">
        Are you sure you want to delete "{{ deleteTarget?.name }}"? This will disconnect all tools from this server.
      </p>
      <div class="dialog-actions">
        <t-button variant="outline" type="button" @click="deleteDialogVisible = false">
          Cancel
        </t-button>
        <t-button theme="danger" type="button" :loading="deleting" @click="submitDelete">
          Delete
        </t-button>
      </div>
    </t-dialog>
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

.page-header-actions {
  display: flex;
  align-items: center;
  gap: @space-3;
  flex-shrink: 0;
}

/* ========== Server 列表 ========== */
.server-list {
  display: flex;
  flex-direction: column;
  gap: @space-2;
}

.server-row {
  display: flex;
  align-items: center;
  gap: @space-4;
  padding: @space-5 @space-6;
  background: @color-bg-surface;
  border: 1px solid @color-border;
  border-radius: @radius-lg;
  transition: all 180ms @ease-standard;
  animation: fade-slide-up @duration-normal @ease-out both;

  &:hover {
    border-color: @color-border-strong;
    box-shadow: @shadow-sm;

    .server-main .server-name {
      color: @primary;
    }

    .row-more-btn {
      opacity: 1;
    }
  }

  .server-icon {
    width: 44px;
    height: 44px;
    border-radius: @radius-md;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    flex-shrink: 0;
    transition: all 180ms @ease-standard;

    &.connected {
      background: lighten(@color-success, 42%);
      color: @color-success;
    }

    &.error {
      background: lighten(@color-error, 42%);
      color: @color-error;
    }

    &.disconnected {
      background: @color-bg-hover;
      color: @color-text-tertiary;
    }
  }

  .server-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    cursor: pointer;

    .server-name {
      font-size: @font-md;
      font-weight: 600;
      color: @color-text;
      transition: color 180ms @ease-standard;
    }

    .server-url {
      font-size: @font-sm;
      color: @color-text-secondary;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: "Menlo", "Consolas", monospace;
    }

    .server-desc {
      font-size: @font-xs;
      color: @color-text-tertiary;
    }
  }

  .server-status {
    display: flex;
    align-items: center;
    gap: @space-2;
    flex-shrink: 0;

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;

      &.connected {
        background: @color-success;
        box-shadow: 0 0 4px @color-success;
      }

      &.error {
        background: @color-error;
      }

      &.disconnected {
        background: @color-text-tertiary;
      }
    }

    .status-text {
      font-size: @font-xs;
      font-weight: 500;

      &.connected {
        color: @color-success;
      }

      &.error {
        color: @color-error;
      }

      &.disconnected {
        color: @color-text-tertiary;
      }
    }
  }

  .server-tools {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex-shrink: 0;

    .tool-count {
      font-size: @font-md;
      font-weight: 600;
      color: @color-text;
    }

    .tool-label {
      font-size: 10px;
      color: @color-text-tertiary;
    }
  }

  .server-transport {
    flex-shrink: 0;

    .transport-badge {
      font-size: 10px;
      font-weight: 600;
      padding: 2px @space-2;
      border-radius: @radius-pill;
      background: @color-bg-hover;
      color: @color-text-secondary;
      font-family: "Menlo", "Consolas", monospace;
    }
  }

  .server-updated {
    font-size: @font-xs;
    color: @color-text-tertiary;
    flex-shrink: 0;
  }

  .server-row-actions {
    display: flex;
    align-items: center;
    gap: @space-1;
    flex-shrink: 0;

    .row-more-btn {
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
      opacity: 0;
      transition: all @duration-fast;

      &:hover {
        background: @color-bg-hover;
        color: @color-text;
      }
    }
  }

  &:hover .row-more-btn {
    opacity: 1;
  }
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
    max-width: 400px;
    margin: 0 0 @space-6;
  }
}

/* ========== 对话框 ========== */
.delete-tip {
  font-size: @font-md;
  color: @color-text;
  margin: 0;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: @space-2;
  margin-top: @space-4;
}

.form-alert {
  margin-bottom: @space-2;
}
</style>
