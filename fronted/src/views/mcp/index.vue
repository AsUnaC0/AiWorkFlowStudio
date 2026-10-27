<script setup lang="ts">
import { onMounted, ref } from "vue";
import {
  createMcpServer,
  getMcpCapabilities,
  getMcpServers,
  updateMcpServer,
  removeMcpServer,
  testMcpConnection,
  refreshMcpTools,
} from "@/api/mcp";
import { MessagePlugin } from "tdesign-vue-next";
import type {
  McpCapabilities,
  McpServer,
  McpTransportKind,
  TestConnectionResult,
} from "@/types/mcp";

// ========== 传输能力（stdio 默认关闭，关闭时不出现在选项里） ==========
const capabilities = ref<McpCapabilities | null>(null);
const stdioEnabled = ref(false);

const fetchCapabilities = async () => {
  try {
    const caps = await getMcpCapabilities();
    capabilities.value = caps;
    stdioEnabled.value = caps.stdio.enabled;
  } catch {
    // 拿不到能力就按最保守的来：只显示远程传输
    stdioEnabled.value = false;
  }
};

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
  transport: "STREAMABLE_HTTP" as McpTransportKind,
  serverUrl: "",
  // stdio 专用：args / env 在表单里按「一行一项」「KEY=VALUE」编辑，提交时再解析
  command: "",
  argsText: "",
  envText: "",
  authType: "NONE" as "NONE" | "API_KEY" | "BEARER_TOKEN",
  apiKey: "",
  bearerToken: "",
});

const isStdio = () => formData.value.transport === "STDIO";

const resetForm = () => {
  formData.value = {
    name: "",
    description: "",
    transport: "STREAMABLE_HTTP",
    serverUrl: "",
    command: "",
    argsText: "",
    envText: "",
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
    serverUrl: server.serverUrl || "",
    command: server.command || "",
    argsText: Array.isArray(server.args) ? server.args.join("\n") : "",
    // 环境变量的「值」后端不会返回，这里只回显键名，留空表示不修改
    envText: (server.envKeys ?? []).map((k) => `${k}=`).join("\n"),
    authType: server.authType,
    apiKey: "",
    bearerToken: "",
  };
  formError.value = "";
  createDialogVisible.value = true;
};

/** 把 textarea 里的多行参数解析成数组（忽略空行与首尾空格） */
const parseArgs = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/** 把 KEY=VALUE 多行解析成对象；值为空的行忽略（编辑时用来保留原值） */
const parseEnv = (text: string): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (key && value) env[key] = value;
  }
  return env;
};

const submitForm = async () => {
  const name = formData.value.name.trim();
  if (!name) {
    formError.value = "请输入 MCP Server 名称";
    return;
  }

  const stdio = isStdio();
  const url = formData.value.serverUrl.trim();
  const command = formData.value.command.trim();

  if (stdio) {
    if (!command) {
      formError.value = "本地进程（stdio）需要填写启动命令，例如 npx";
      return;
    }
  } else if (!url) {
    formError.value = "请输入 Server URL";
    return;
  }

  if (
    !stdio &&
    formData.value.authType === "API_KEY" &&
    !formData.value.apiKey &&
    !editingServer.value
  ) {
    formError.value = "选择 API Key 认证时请填写 API Key";
    return;
  }
  if (
    !stdio &&
    formData.value.authType === "BEARER_TOKEN" &&
    !formData.value.bearerToken &&
    !editingServer.value
  ) {
    formError.value = "选择 Bearer Token 认证时请填写 Token";
    return;
  }

  formSaving.value = true;
  formError.value = "";
  try {
    const payload = stdio
      ? {
          name,
          description: formData.value.description.trim() || undefined,
          transport: formData.value.transport,
          command,
          args: parseArgs(formData.value.argsText),
          // 只有填了值才提交 env；全空表示不修改（避免编辑时把已有变量清掉）
          ...(() => {
            const env = parseEnv(formData.value.envText);
            return Object.keys(env).length > 0 ? { env } : {};
          })(),
        }
      : {
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
  } catch (err: unknown) {
    // 后端的校验信息（白名单 / 未启用 stdio / SSRF）比通用文案有用得多
    const message =
      (err as { response?: { data?: { message?: string } } })?.response?.data
        ?.message ||
      (editingServer.value ? "更新失败，请稍后重试" : "创建失败，请稍后重试");
    formError.value = Array.isArray(message) ? message.join("；") : message;
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

// ========== 测试连接 / 刷新工具 ==========
const testingId = ref<string | null>(null);
const refreshingId = ref<string | null>(null);

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

const handleRefreshTools = async (server: McpServer) => {
  refreshingId.value = server.id;
  try {
    const result: TestConnectionResult = await refreshMcpTools(server.id);
    if (result.success) {
      MessagePlugin.success(`工具列表已刷新，共 ${result.tools.length} 个工具`);
    } else {
      MessagePlugin.error(result.message);
    }
    fetchServers();
  } catch {
    MessagePlugin.error("刷新工具列表失败");
  } finally {
    refreshingId.value = null;
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
  if (transport === "STDIO") return "STDIO";
  return transport === "SSE" ? "SSE" : "HTTP";
};

/** 列表里展示的「地址」：远程是 URL，stdio 是「命令 + 参数」 */
const getEndpointLabel = (server: McpServer): string => {
  if (server.serverUrl) return server.serverUrl;
  const args = Array.isArray(server.args) && server.args.length > 0
    ? ` ${server.args.join(" ")}`
    : "";
  return `${server.command || "（未配置命令）"}${args}`;
};

onMounted(() => {
  fetchServers();
  fetchCapabilities();
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
          <div v-for="server in servers" :key="server.id" class="server-row">
            <!-- 图标 -->
            <div class="server-icon" :class="getStatusInfo(server).cls">
              <t-icon name="plugin" />
            </div>

            <!-- 主信息 -->
            <div class="server-main" @click="openEditDialog(server)">
              <div class="server-name">{{ server.name }}</div>
              <div class="server-url">{{ getEndpointLabel(server) }}</div>
              <div v-if="server.description" class="server-desc">
                {{ server.description }}
              </div>
              <div class="server-meta">
                <span v-if="server.protocolVersion" class="meta-chip">
                  MCP {{ server.protocolVersion }}
                </span>
                <span v-if="server.serverName" class="meta-text">
                  {{ server.serverName }}{{ server.serverVersion ? ` v${server.serverVersion}` : "" }}
                </span>
                <span v-if="server.lastConnectedAt" class="meta-text">
                  Last connected {{ formatRelativeTime(server.lastConnectedAt) }}
                </span>
              </div>
              <div v-if="server.status === 'ERROR' && server.lastError" class="server-error">
                {{ server.lastError }}
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
              <t-button size="small" theme="primary" variant="outline" :loading="testingId === server.id"
                @click.stop="handleTestConnection(server)">
                Test
              </t-button>
              <t-button size="small" variant="outline" :loading="refreshingId === server.id"
                @click.stop="handleRefreshTools(server)">
                Refresh
              </t-button>
              <t-button variant="text" shape="square" size="small" title="Edit" @click.stop="openEditDialog(server)">
                <t-icon name="edit-1" />
              </t-button>
              <t-button theme="danger" variant="text" shape="square" size="small" title="Delete"
                @click.stop="openDeleteDialog(server)">
                <t-icon name="delete" />
              </t-button>
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
    <t-dialog v-model:visible="createDialogVisible" :header="editingServer ? 'Edit MCP Server' : 'Add MCP Server'"
      :confirm-btn="{ content: editingServer ? 'Save' : 'Add', theme: 'primary', loading: formSaving }"
      cancel-btn="Cancel" width="560px" @confirm="submitForm">
      <t-form layout="vertical" label-align="top" @submit="submitForm">
        <t-form-item label="Name">
          <t-input v-model="formData.name" placeholder="GitHub MCP" maxlength="200" />
        </t-form-item>
        <t-form-item label="Description (optional)">
          <t-textarea v-model="formData.description" placeholder="GitHub repository management tool" :maxlength="1000"
            :autosize="{ minRows: 2, maxRows: 4 }" />
        </t-form-item>
        <t-form-item label="Transport">
          <t-radio-group v-model="formData.transport">
            <t-radio value="STREAMABLE_HTTP">Streamable HTTP</t-radio>
            <t-radio value="SSE">SSE</t-radio>
            <t-radio v-if="stdioEnabled" value="STDIO">Local process (stdio)</t-radio>
          </t-radio-group>
        </t-form-item>

        <!-- 本地进程：command + args + env，没有 URL，也没有 HTTP 认证 -->
        <template v-if="isStdio()">
          <t-form-item label="Command">
            <t-input v-model="formData.command" placeholder="npx" maxlength="500" />
          </t-form-item>
          <t-form-item label="Arguments (one per line)">
            <t-textarea v-model="formData.argsText" placeholder="-y&#10;fetcher-mcp"
              :autosize="{ minRows: 2, maxRows: 6 }" />
          </t-form-item>
          <t-form-item label="Environment (KEY=VALUE, one per line)">
            <t-textarea v-model="formData.envText" placeholder="GITHUB_TOKEN=ghp_xxx"
              :autosize="{ minRows: 2, maxRows: 6 }" />
          </t-form-item>
          <t-alert theme="warning" class="form-alert"
            :message="`本地进程会在服务器上直接执行命令。允许的命令：${(capabilities?.stdio.allowedCommands || []).join(' / ') || '—'}；密钥请填在环境变量里，不要写在参数中。`" />
        </template>

        <template v-else>
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
            <t-input v-model="formData.apiKey" type="password"
              :placeholder="editingServer ? 'Enter new key to update' : 'Your API key'" />
          </t-form-item>
          <t-form-item v-if="formData.authType === 'BEARER_TOKEN'" label="Bearer Token">
            <t-input v-model="formData.bearerToken" type="password"
              :placeholder="editingServer ? 'Enter new token to update' : 'Your bearer token'" />
          </t-form-item>
          <t-alert v-if="editingServer && editingServer.hasCredentials" theme="info" class="form-alert"
            :message="`已保存凭据：${editingServer.credentialPreview || '****'}（留空表示不修改）`" />
        </template>
        <t-alert v-if="formError" theme="error" :message="formError" class="form-alert" />
      </t-form>
    </t-dialog>

    <!-- 删除确认 -->
    <t-dialog v-model:visible="deleteDialogVisible" header="Delete MCP Server"
      :confirm-btn="{ content: 'Delete', theme: 'danger', loading: deleting }" cancel-btn="Cancel" width="420px"
      @confirm="submitDelete">
      <p class="delete-tip">
        Are you sure you want to delete "{{ deleteTarget?.name }}"? This will disconnect all tools from this server.
      </p>
    </t-dialog>
  </div>
</template>

<style scoped lang="less">
@import "../../styles/variables.less";

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

    .server-meta {
      display: flex;
      align-items: center;
      gap: @space-2;
      flex-wrap: wrap;
      margin-top: 2px;
    }

    .meta-chip {
      font-size: @font-xs;
      padding: 1px 6px;
      border-radius: @radius-sm;
      background: fade(@primary, 12%);
      color: @primary;
      font-family: @font-mono;
    }

    .meta-text {
      font-size: @font-xs;
      color: @color-text-tertiary;
    }

    .server-error {
      margin-top: 2px;
      font-size: @font-xs;
      color: @color-error;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 420px;
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
  }
}

/* ========== 对话框 ========== */
.delete-tip {
  font-size: @font-md;
  color: @color-text;
  margin: 0;
}

.form-alert {
  margin-bottom: @space-2;
}
</style>
