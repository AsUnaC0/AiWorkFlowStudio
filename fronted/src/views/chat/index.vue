<script setup lang="ts">
import {
  computed,
  nextTick,
  onActivated,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  listAgents,
  createAgent,
  deleteAgent,
  listSessions,
  createSession,
  deleteSession,
  getSession,
  runAgentStream,
  type Agent,
  type ChatSessionListItem,
  type ChatMessage,
  type AgentStreamEvent,
} from "@/api/agent";
import {
  AGENT_TEMPLATES,
  isPlatformAssistantAgent,
  OPERATION_STATUS_META,
  RISK_LEVEL_META,
  type AgentOperation,
  type AgentType,
} from "@/types/agent";
import {
  getPlatformAssistant,
  listPlatformOperations,
  type PlatformAssistantInfo,
  type PlatformOperationRecord,
} from "@/api/platform";
import type { GeneratedFile } from "@/types/files";
import { downloadFile } from "@/api/files";
import GeneratedFileCard from "@/components/files/GeneratedFileCard.vue";
import FilePreviewDrawer from "@/components/files/FilePreviewDrawer.vue";
import ChatFilePreviewDrawer from "@/components/files/ChatFilePreviewDrawer.vue";
import ChatAttachmentBar from "@/components/files/ChatAttachmentBar.vue";
import {
  getChatFilePolicy,
  uploadChatFile,
  getChatFileStatuses,
  deleteChatFile,
  downloadChatFile,
} from "@/api/files";
import type { ChatAttachment, ChatFilePolicy } from "@/types/files";
import { fileIcon, fileColor } from "@/types/files";
import { getLlmModels } from "@/api/provider";
import { type LlmModel, PROVIDER_LABELS } from "@/types/provider";
import { MessagePlugin, DialogPlugin } from "tdesign-vue-next";
import { isAuthFailure } from "@/utils/request";

// 必须与路由 name 一致 —— MainLayout 的 <keep-alive :include> 按组件 name 匹配，
// 名字对不上缓存会静默失效（表现为「切菜单回来回答还是丢了」）。
defineOptions({ name: "Chat" });

// ===========================================================================
// 状态
// ===========================================================================

const route = useRoute();
const router = useRouter();

// Agent 列表
const agents = ref<Agent[]>([]);
const loadingAgents = ref(false);

// 当前选中的 Agent
const currentAgentId = ref<string>("");

// 会话列表（当前 Agent 下）
const sessions = ref<ChatSessionListItem[]>([]);
const loadingSessions = ref(false);

// 当前选中的会话
const currentSessionId = ref<string>("");

// 聊天消息
const messages = ref<ChatMessage[]>([]);
const loadingMessages = ref(false);

// 发送状态
const sending = ref(false);
const inputText = ref("");
const inputRef = ref<HTMLTextAreaElement | null>(null);
const chatContainerRef = ref<HTMLElement | null>(null);

// ===========================================================================
// 平台助理（默认系统 Agent）
//
// 它不是普通聊天 Agent，而是「理解当前用户 + 了解平台资源 + 可执行平台操作」的统一入口。
// 前端需要做的：
//   1. 识别它（isSystem && isDefault），展示专属标识
//   2. 把「当前工作空间」作为意图传给后端（后端会重新校验成员关系）
//   3. 把平台操作（operation 事件）渲染成操作卡片，而不是一堆裸 JSON
// ===========================================================================

const platformInfo = ref<PlatformAssistantInfo | null>(null);
const operationsVisible = ref(false);
const operationsLoading = ref(false);
const operations = ref<PlatformOperationRecord[]>([]);

/** 当前选中的 Agent 是否为平台助理 */
const isPlatformAssistant = computed(() =>
  isPlatformAssistantAgent(currentAgent.value),
);

/** 当前工作空间（仅平台助理有意义；后端仍会重新校验） */
const currentWorkspaceId = computed(
  () => platformInfo.value?.currentWorkspaceId ?? undefined,
);

const currentWorkspaceLabel = computed(() => {
  if (!isPlatformAssistant.value) return "";
  const info = platformInfo.value;
  if (!info) return "加载中…";
  if (!info.currentWorkspaceId) return "未指定工作空间";
  return info.currentWorkspaceName || "未命名空间";
});

/** 加载平台助理信息（能力清单 + 可访问工作空间） */
const loadPlatformAssistant = async () => {
  try {
    platformInfo.value = await getPlatformAssistant();
  } catch {
    platformInfo.value = null;
  }
};

/** 切换当前工作空间（只影响后续对话的上下文） */
const switchWorkspace = (workspaceId: string | undefined) => {
  if (!platformInfo.value) return;
  const ws = platformInfo.value.workspaces.find((w) => w.id === workspaceId);
  platformInfo.value = {
    ...platformInfo.value,
    currentWorkspaceId: ws?.id ?? null,
    currentWorkspaceName: ws?.name ?? null,
  };
};

/** 打开操作记录抽屉（审计数据） */
const openOperations = async () => {
  operationsVisible.value = true;
  operationsLoading.value = true;
  try {
    operations.value = await listPlatformOperations({ limit: 50 });
  } catch {
    operations.value = [];
  } finally {
    operationsLoading.value = false;
  }
};

/** 点击操作卡片跳转到对应资源 */
const openOperationLink = (link?: string) => {
  if (!link) return;
  operationsVisible.value = false;
  router.push(link);
};

// ===========================================================================
// 聊天附件（上传文件随消息交给 AI 解析上下文，与知识库解耦）
// ===========================================================================

const filePolicy = ref<ChatFilePolicy | null>(null);
/** 当前待发送消息携带的附件（含上传中 / 解析中状态） */
const pendingAttachments = ref<ChatAttachment[]>([]);
const uploading = ref(false);

/** 附件预览抽屉 */
const chatFilePreviewVisible = ref(false);
const activeAttachment = ref<ChatAttachment | null>(null);

const addFiles = async (files: File[]) => {
  if (filePolicy.value) {
    const { maxSize, maxPerMessage, allowedExtensions } = filePolicy.value;
    for (const f of files) {
      const ext = (f.name.split(".").pop() ?? "").toLowerCase();
      if (!allowedExtensions.includes(ext)) {
        MessagePlugin.error(`不支持的文件类型：.${ext}`);
        return;
      }
      if (f.size > maxSize) {
        MessagePlugin.error(
          `文件「${f.name}」超过大小上限（${Math.floor(maxSize / 1024 / 1024)}MB）`,
        );
        return;
      }
    }
    if (pendingAttachments.value.length + files.length > maxPerMessage) {
      MessagePlugin.error(`单次最多上传 ${maxPerMessage} 个附件`);
      return;
    }
  }

  uploading.value = true;
  try {
    for (const f of files) {
      const tempId = `uploading-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const ext = (f.name.split(".").pop() ?? "").toLowerCase();
      pendingAttachments.value.push({
        id: tempId,
        originalName: f.name,
        mimeType: f.type || "application/octet-stream",
        extension: ext,
        size: f.size,
        kind: "",
        status: "PROCESSING",
        previewType: "",
        summary: null,
        parseError: null,
        charCount: 0,
        createdAt: new Date().toISOString(),
      });

      try {
        const att = await uploadChatFile(f, currentSessionId.value || undefined);
        const idx = pendingAttachments.value.findIndex((a) => a.id === tempId);
        if (idx >= 0) pendingAttachments.value[idx] = att;
        void pollStatus(att.id);
      } catch (err) {
        const idx = pendingAttachments.value.findIndex((a) => a.id === tempId);
        if (idx >= 0) pendingAttachments.value[idx].status = "FAILED";
        MessagePlugin.error(err instanceof Error ? err.message : "上传失败");
      }
    }
  } finally {
    uploading.value = false;
  }
};

/** 轮询附件解析状态，直到 READY / FAILED（最多约 40s） */
const pollStatus = async (id: string) => {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const idx = pendingAttachments.value.findIndex((a) => a.id === id);
    if (idx < 0) return; // 已被移除
    try {
      const [att] = await getChatFileStatuses([id]);
      if (att) pendingAttachments.value[idx] = att;
      if (att && (att.status === "READY" || att.status === "FAILED")) return;
    } catch {
      // 忽略单次轮询错误，继续
    }
  }
};

const removePendingAttachment = async (id: string) => {
  const att = pendingAttachments.value.find((a) => a.id === id);
  if (att && !id.startsWith("uploading-")) {
    try {
      await deleteChatFile(id);
    } catch {
      // 忽略删除失败
    }
  }
  pendingAttachments.value = pendingAttachments.value.filter((a) => a.id !== id);
};

const openAttachmentPreview = (att: ChatAttachment) => {
  activeAttachment.value = att;
  chatFilePreviewVisible.value = true;
};

const handleDownloadAttachment = async (att: ChatAttachment) => {
  try {
    await downloadChatFile(att);
  } catch (err) {
    MessagePlugin.error(err instanceof Error ? err.message : "文件下载失败");
  }
};

const loadChatFilePolicy = async () => {
  try {
    filePolicy.value = await getChatFilePolicy();
  } catch {
    filePolicy.value = null;
  }
};

// Trail 展开控制
const expandedTrails = ref<Set<string>>(new Set());
const toggleTrail = (msgId: string) => {
  if (expandedTrails.value.has(msgId)) expandedTrails.value.delete(msgId);
  else expandedTrails.value.add(msgId);
};

// 侧边栏折叠
const sidebarCollapsed = ref(false);

// ===========================================================================
// 生成文件（Agent generate_file 工具产出）
// ===========================================================================

const previewVisible = ref(false);
const activeFile = ref<GeneratedFile | null>(null);

const openPreview = (file: GeneratedFile) => {
  activeFile.value = file;
  previewVisible.value = true;
};

const handleDownloadFile = async (file: GeneratedFile) => {
  try {
    await downloadFile(file);
  } catch (err) {
    MessagePlugin.error(err instanceof Error ? err.message : "文件下载失败");
  }
};

// 创建 Agent 对话框
const showCreateDialog = ref(false);
const creatingAgent = ref({
  name: "",
  type: "CUSTOM" as AgentType,
  description: "",
});
const creatingAgentLoading = ref(false);

// ===========================================================================
// 计算属性
// ===========================================================================

const currentAgent = computed(() =>
  agents.value.find((a) => a.id === currentAgentId.value),
);

// 用户在「模型管理」中添加的对话模型（用于展示 Agent 实际使用的模型名）
const userModels = ref<LlmModel[]>([]);
const loadModels = async () => {
  try {
    userModels.value = await getLlmModels("CHAT");
  } catch {
    userModels.value = [];
  }
};

/**
 * Agent 实际使用的模型名：
 * 优先展示所选自定义模型的显示名，未绑定自定义模型时回退到本地 model。
 * 注意：切换模型只会更新 llmModelId，`agent.model` 始终是本地默认值，
 * 因此这里不能再直接用 currentAgent.model。
 */
const activeModelLabel = computed(() => {
  const a = currentAgent.value;
  if (!a) return "";
  if (a.llmModelId) {
    const m = userModels.value.find((x) => x.id === a.llmModelId);
    if (m) return m.displayName || m.modelId;
  }
  // 后端已把 agent.model 同步为真实模型名，直接回退即可
  return a.model;
});

/** 悬浮提示：展示提供商信息，便于确认当前到底用的哪个模型 */
const activeModelHint = computed(() => {
  const a = currentAgent.value;
  if (!a) return "";
  if (a.llmModelId) {
    const m = userModels.value.find((x) => x.id === a.llmModelId);
    if (m) return `${m.modelId} · ${PROVIDER_LABELS[m.provider] ?? m.provider}`;
  }
  return `本地 Ollama · ${a.model}`;
});

/** 后端通过 SSE `meta` 事件回报的「本次实际使用模型」，最权威 */
const runtimeModel = ref("");
/** 头部展示：优先后端回报，其次按 llmModelId 解析，最后回退 agent.model */
const displayModel = computed(() => runtimeModel.value || activeModelLabel.value);
const modelTitle = computed(() =>
  runtimeModel.value
    ? `本次实际使用：${runtimeModel.value}`
    : activeModelHint.value,
);

const isEmpty = computed(() => messages.value.length === 0);

const canSend = computed(
  () =>
    !sending.value &&
    currentAgentId.value &&
    (inputText.value.trim().length > 0 ||
      pendingAttachments.value.some((a) => a.status === "READY")),
);

// ===========================================================================
// 加载函数
// ===========================================================================

const loadAgents = async () => {
  loadingAgents.value = true;
  try {
    agents.value = await listAgents();

    // 优先采用 URL 上的 ?agent=<id>（从 Agent 管理页点「对话」跳转时携带），
    // 否则保持当前选中，最后回退到默认 Agent。
    const queryAgentId = route.query.agent as string | undefined;
    const fromQuery =
      queryAgentId && agents.value.some((a) => a.id === queryAgentId)
        ? queryAgentId
        : "";

    if (fromQuery) {
      currentAgentId.value = fromQuery;
    } else if (!currentAgentId.value && agents.value.length > 0) {
      // 优先选 isDefault 的
      const defaultAgent = agents.value.find((a) => a.isDefault);
      currentAgentId.value = defaultAgent?.id ?? agents.value[0].id;
    }
  } catch (err) {
    // 登录失效时拦截器已经统一提示并跳转，这里不再补一条
    if (!isAuthFailure(err)) MessagePlugin.error("加载 Agent 列表失败");
  } finally {
    loadingAgents.value = false;
  }
};

const loadSessions = async () => {
  if (!currentAgentId.value) {
    sessions.value = [];
    return;
  }
  loadingSessions.value = true;
  try {
    sessions.value = await listSessions(currentAgentId.value);

    // 如果有会话，选中第一个
    if (sessions.value.length > 0 && !currentSessionId.value) {
      currentSessionId.value = sessions.value[0].id;
      await loadMessages();
    } else if (sessions.value.length === 0) {
      currentSessionId.value = "";
      messages.value = [];
    }
  } catch {
    sessions.value = [];
  } finally {
    loadingSessions.value = false;
  }
};

const loadMessages = async () => {
  if (!currentSessionId.value) {
    messages.value = [];
    return;
  }
  loadingMessages.value = true;
  try {
    const detail = await getSession(currentSessionId.value);
    messages.value = detail.messages.filter(
      (m) => m.role === "user" || m.role === "assistant",
    );
  } catch {
    messages.value = [];
  } finally {
    loadingMessages.value = false;
  }
};

// ===========================================================================
// 切换 Agent
// ===========================================================================

const switchAgent = (agentId: string) => {
  if (agentId === currentAgentId.value) return;
  currentAgentId.value = agentId;
  // watch(currentAgentId) 会自动触发 loadSessions
};

// 监听 Agent 变化，重新加载会话
watch(currentAgentId, async () => {
  currentSessionId.value = "";
  messages.value = [];
  sessions.value = [];
  runtimeModel.value = "";
  // 切到平台助理时，拉取它的能力清单与可访问工作空间
  if (isPlatformAssistant.value) await loadPlatformAssistant();
  await loadSessions();
});

// URL 上的 ?agent= 变化时（例如从 Agent 管理页再次点「对话」），同步切换
watch(
  () => route.query.agent,
  (agentId) => {
    if (typeof agentId === "string" && agentId && agentId !== currentAgentId.value) {
      currentAgentId.value = agentId;
    }
  },
);

// ===========================================================================
// 会话操作
// ===========================================================================

const createNewSession = async () => {
  if (!currentAgentId.value) return;
  try {
    const session = await createSession(currentAgentId.value, "新对话");
    currentSessionId.value = session.id;
    await loadSessions();
    messages.value = [];
    inputRef.value?.focus();
  } catch {
    MessagePlugin.error("创建会话失败");
  }
};

const switchSession = async (sessionId: string) => {
  if (sessionId === currentSessionId.value) return;
  currentSessionId.value = sessionId;
  runtimeModel.value = "";
  await loadMessages();
};

const handleDeleteSession = async (sessionId: string) => {
  const confirmDialog = DialogPlugin.confirm({
    header: "确认删除",
    body: "确定要删除这个会话吗？删除后无法恢复。",
    confirmBtn: { content: "删除", theme: "danger" },
    cancelBtn: { content: "取消" },
    onConfirm: async () => {
      try {
        await deleteSession(sessionId);
        if (sessionId === currentSessionId.value) {
          currentSessionId.value = "";
          messages.value = [];
        }
        await loadSessions();
        confirmDialog.destroy();
      } catch {
        MessagePlugin.error("删除会话失败");
      }
    },
    onClose: () => confirmDialog.destroy(),
  });
};

// ===========================================================================
// 创建 Agent
// ===========================================================================

const openCreateDialog = (type?: AgentType) => {
  creatingAgent.value = {
    name: "",
    type: type ?? "CUSTOM",
    description: "",
  };
  showCreateDialog.value = true;
};

const handleCreateAgent = async () => {
  const { name, type, description } = creatingAgent.value;
  if (!name.trim()) {
    MessagePlugin.warning("请输入 Agent 名称");
    return;
  }

  creatingAgentLoading.value = true;
  try {
    const agent = await createAgent({
      name: name.trim(),
      type,
      description: description.trim() || undefined,
    });
    showCreateDialog.value = false;
    MessagePlugin.success("Agent 创建成功");

    // 刷新列表并选中新创建的 Agent
    await loadAgents();
    currentAgentId.value = agent.id;
  } catch (err) {
    MessagePlugin.error("创建 Agent 失败");
  } finally {
    creatingAgentLoading.value = false;
  }
};

const handleDeleteAgent = async (agentId: string) => {
  const agent = agents.value.find((a) => a.id === agentId);
  if (!agent) return;

  if (agent.isDefault) {
    MessagePlugin.warning("默认 Agent 不能删除");
    return;
  }

  const confirmDialog = DialogPlugin.confirm({
    header: "确认删除",
    body: `确定要删除 Agent「${agent.name}」吗？该 Agent 下的所有会话也会被删除。`,
    confirmBtn: { content: "删除", theme: "danger" },
    cancelBtn: { content: "取消" },
    onConfirm: async () => {
      try {
        await deleteAgent(agentId);
        // 如果删除的是当前 Agent，切换到第一个
        if (agentId === currentAgentId.value) {
          currentAgentId.value = "";
        }
        await loadAgents();
        confirmDialog.destroy();
        MessagePlugin.success("Agent 已删除");
      } catch (err) {
        MessagePlugin.error("删除 Agent 失败");
      }
    },
    onClose: () => confirmDialog.destroy(),
  });
};

// ===========================================================================
// 聊天交互
// ===========================================================================

/** 进行中的流式请求。组件被真正销毁时中止，避免流继续跑却无人接收 */
let streamAbort: AbortController | null = null;

/** 组件是否已真正销毁。注意：keep-alive 缓存下切换菜单**不会**置为 true */
let disposed = false;

const scrollToBottom = async () => {
  await nextTick();
  if (chatContainerRef.value) {
    chatContainerRef.value.scrollTo({
      top: chatContainerRef.value.scrollHeight,
      behavior: "smooth",
    });
  }
};

const handleAgentEvent = (event: AgentStreamEvent, assistantMsgId: string) => {
  // meta 事件不属于某条消息，先单独处理（后端回报本次实际使用的模型）
  if (event.type === "meta") {
    runtimeModel.value = event.model;
    return;
  }

  const msg = messages.value.find((m) => m.id === assistantMsgId);
  if (!msg) return;

  switch (event.type) {
    case "thinking":
    case "tool_call":
    case "tool_result": {
      if (!msg.trail) msg.trail = [];
      msg.trail.push(event as unknown as Record<string, unknown>);
      break;
    }
    case "operation": {
      // 平台助理执行了一次平台操作 —— 渲染为操作卡片（风险等级 / 目标资源 / 跳转）
      if (!msg.trail) msg.trail = [];
      msg.trail.push(event as unknown as Record<string, unknown>);
      // 顺带刷新操作记录，保证抽屉里的数据是新的
      if (operationsVisible.value) void openOperations();
      break;
    }
    case "file": {
      // Agent 调用了 generate_file —— 文件已真实生成并落库，渲染为文件卡片
      if (!msg.files) msg.files = [];
      if (!msg.files.some((f) => f.id === event.file.id)) {
        msg.files.push(event.file);
      }
      break;
    }
    case "message": {
      msg.content = event.content;
      break;
    }
    case "error": {
      msg.content = `⚠️ ${event.message}`;
      break;
    }
  }
  scrollToBottom();
};

const send = async () => {
  if (!canSend.value || !currentAgentId.value) return;

  // 确保有会话
  if (!currentSessionId.value) {
    const session = await createSession(currentAgentId.value, "新对话");
    currentSessionId.value = session.id;
    await loadSessions();
  }

  // 附件处理：只发送已解析完成的；仍在解析中的先提示等待
  const readyAttachments = pendingAttachments.value.filter(
    (a) => a.status === "READY" && !a.id.startsWith("uploading-"),
  );
  const stillProcessing = pendingAttachments.value.filter(
    (a) => a.status !== "READY",
  );
  if (stillProcessing.length > 0) {
    MessagePlugin.warning("还有附件正在解析，请等待解析完成后再发送");
    return;
  }

  const userText = inputText.value.trim();
  if (!userText && readyAttachments.length === 0) return;

  // 抓取待展示 / 待发送的附件快照，然后清空输入框与待发送列表
  const displayAttachments = [...readyAttachments];
  const attachmentIds = readyAttachments.map((a) => a.id);

  inputText.value = "";

  // 添加用户消息到界面（携带附件快照，便于回看）
  messages.value.push({
    id: `temp-user-${Date.now()}`,
    sessionId: currentSessionId.value,
    role: "user",
    content: userText,
    attachments: displayAttachments,
    createdAt: new Date().toISOString(),
  });

  // 清空待发送附件
  pendingAttachments.value = [];

  // 添加空的 assistant 消息（等待 SSE 填充）
  const assistantMsgId = `temp-assistant-${Date.now()}`;
  messages.value.push({
    id: assistantMsgId,
    sessionId: currentSessionId.value,
    role: "assistant",
    content: "",
    trail: [],
    createdAt: new Date().toISOString(),
  });

  sending.value = true;
  scrollToBottom();

  streamAbort = new AbortController();
  try {
    await runAgentStream(
      {
        agentId: currentAgentId.value,
        sessionId: currentSessionId.value,
        input: userText,
        attachmentIds,
        // 平台助理需要知道「当前工作空间」，后端会重新校验成员关系
        workspaceId: isPlatformAssistant.value
          ? currentWorkspaceId.value
          : undefined,
      },
      (event) => handleAgentEvent(event, assistantMsgId),
      streamAbort.signal,
    );
  } catch (err) {
    // 组件被销毁导致的主动中止：静默处理，不打扰用户
    if (err instanceof Error && err.name === "AbortError") return;
    const msg = err instanceof Error ? err.message : "Agent 请求失败";
    MessagePlugin.error(msg);
  } finally {
    streamAbort = null;
    sending.value = false;
    // 消息会在 SSE 过程中被逐步填充
    // 最后刷新一下会话列表更新 updatedAt
    if (!disposed) {
      loadSessions();
      scrollToBottom();
    }
  }
};

const onKeydown = (e: KeyboardEvent) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
};

const formatTime = (iso: string) => {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
};

// ===========================================================================
// 生命周期与页面缓存
//
// 本页面被 keep-alive 缓存（路由 meta.keepAlive + 上方 defineOptions 的 name）。
// 这是「流式回答不丢」的关键：handleAgentEvent 依赖 messages 里的消息对象，
// 组件一旦销毁，回调找不到目标消息就会静默丢弃数据 —— 表现就是
// 「切菜单再回来，AI 的回答是空的」。
//
// 缓存带来两个必须补处理的副作用：
//   1. 滚动位置丢失 —— DOM 被移出文档再插回时，浏览器会把 scrollTop 重置为 0
//   2. 数据可能陈旧 —— 切走期间会话列表可能在别处被改动
// ===========================================================================

/**
 * 切走前的滚动状态。
 * 不能在 onDeactivated 里读 scrollTop —— 该钩子触发时 DOM 已被移走、scrollTop 已归零，
 * 所以改为滚动时持续记录。
 */
let lastScrollTop = 0;
let wasAtBottom = true;

const trackScroll = () => {
  const el = chatContainerRef.value;
  if (!el) return;
  lastScrollTop = el.scrollTop;
  wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
};

/** 首次挂载由 onMounted 负责初始化；onActivated 首次也会触发，需跳过以免重复请求 */
let activatedOnce = false;

onActivated(() => {
  if (!activatedOnce) {
    activatedOnce = true;
    return;
  }

  // 还原滚动位置：原本贴底就继续贴底，否则回到原位
  void nextTick(() => {
    const restore = () => {
      const el = chatContainerRef.value;
      if (!el) return;
      el.scrollTop = wasAtBottom ? el.scrollHeight : lastScrollTop;
    };
    restore();
    // 再等一帧，避免代码块/图片撑开高度后定位不准
    requestAnimationFrame(restore);
  });

  // 轻量校准会话列表。正在流式输出时不动，避免与 send 的 finally 重复刷新
  if (currentAgentId.value && !sending.value) void loadSessions();
});

onMounted(async () => {
  await loadModels();
  await loadChatFilePolicy();
  await loadAgents();
  // 平台助理是默认 Agent，首屏就要拿到它的工作空间上下文
  if (isPlatformAssistant.value) await loadPlatformAssistant();
});

onBeforeUnmount(() => {
  // 只有真正销毁（登出、跳转到工作流编辑器等独立路由）才会走到这里；
  // 被缓存时切换菜单走的是 deactivated，状态完整保留，不会进入本函数。
  disposed = true;
  streamAbort?.abort();
  streamAbort = null;
  agents.value = [];
  sessions.value = [];
  messages.value = [];
});

// ===========================================================================
// 辅助函数
// ===========================================================================

const getAgentTemplate = (type: AgentType) =>
  AGENT_TEMPLATES.find((t) => t.type === type);

const formatToolArgs = (args?: Record<string, unknown>) => {
  if (!args) return "";
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
};
const formatToolResult = (result?: string) => {
  if (!result) return "";
  if (result.length > 500) return result.slice(0, 500) + "...";
  return result;
};

/** 风险等级展示配置（容错：未知等级按只读处理） */
const riskMeta = (level?: unknown) =>
  RISK_LEVEL_META[(level as AgentOperation["riskLevel"]) ?? "LOW"] ??
  RISK_LEVEL_META.LOW;

/** 操作状态展示配置（容错：未知状态按成功处理） */
const statusMeta = (status?: unknown) =>
  OPERATION_STATUS_META[(status as AgentOperation["status"]) ?? "SUCCESS"] ??
  OPERATION_STATUS_META.SUCCESS;

/** 从 trail step 里安全取出平台操作对象 */
const stepOperation = (step: Record<string, unknown>) =>
  (step.operation ?? {}) as AgentOperation;
</script>

<template>
  <div class="chat-page">
    <!-- Agent 侧边栏 -->
    <aside class="agent-sidebar" :class="{ collapsed: sidebarCollapsed }">
      <!-- 折叠按钮 -->
      <button class="sidebar-toggle" @click="sidebarCollapsed = !sidebarCollapsed">
        <t-icon :name="sidebarCollapsed ? 'chevron-right' : 'chevron-left'" />
      </button>

      <div v-if="!sidebarCollapsed" class="sidebar-content">
        <!-- Agent 列表 -->
        <div class="agent-section">
          <div class="section-header">
            <span class="section-title">我的 Agent</span>
            <button class="create-btn" @click="openCreateDialog()">
              <t-icon name="add" />
              <span>新建</span>
            </button>
          </div>

          <div class="agent-list">
            <button v-for="agent in agents" :key="agent.id" class="agent-item"
              :class="{ active: agent.id === currentAgentId }" @click="switchAgent(agent.id)">
              <div class="agent-avatar" :class="agent.type.toLowerCase()">
                <t-icon :name="getAgentTemplate(agent.type)?.icon ?? 'chat'" />
              </div>
              <div class="agent-info">
                <div class="agent-name">
                  {{ agent.name }}
                  <t-tag v-if="isPlatformAssistantAgent(agent)" theme="primary" variant="dark" size="small"
                    class="default-tag">
                    平台助理
                  </t-tag>
                  <t-tag v-else-if="agent.isDefault" theme="primary" variant="light" size="small" class="default-tag">
                    默认
                  </t-tag>
                </div>
                <div class="agent-desc">
                  {{ agent.description || agent.type.toLowerCase() }}
                </div>
              </div>
              <t-icon v-if="!agent.isDefault" name="delete" class="agent-delete"
                @click.stop="handleDeleteAgent(agent.id)" />
            </button>

            <div v-if="agents.length === 0 && !loadingAgents" class="agent-empty">
              <p>暂无 Agent</p>
              <button class="create-btn" @click="openCreateDialog()">
                <t-icon name="add" />
                <span>创建第一个 Agent</span>
              </button>
            </div>
          </div>
        </div>

        <!-- 会话列表 -->
        <div v-if="currentAgent" class="session-section">
          <div class="section-header">
            <span class="section-title">会话</span>
            <button class="create-btn text-only" @click="createNewSession">
              <t-icon name="add" />
            </button>
          </div>

          <div class="session-list">
            <div v-for="session in sessions" :key="session.id" class="session-item"
              :class="{ active: session.id === currentSessionId }">
              <button class="session-main" @click="switchSession(session.id)">
                <t-icon name="chat" class="session-icon" />
                <span class="session-title">{{ session.title }}</span>
                <span class="session-time">{{ formatTime(session.updatedAt) }}</span>
              </button>
              <button class="session-delete" title="删除会话" @click="handleDeleteSession(session.id)">
                <t-icon name="close" />
              </button>
            </div>

            <div v-if="sessions.length === 0 && !loadingSessions" class="session-empty">
              暂无会话，开始你的第一条消息吧
            </div>
          </div>
        </div>
      </div>
    </aside>

    <!-- 聊天主体 -->
    <main class="chat-main">
      <!-- Agent 头部信息 -->
      <header v-if="currentAgent" class="chat-header">
        <div class="header-left">
          <div class="agent-avatar lg" :class="currentAgent.type.toLowerCase()">
            <t-icon :name="getAgentTemplate(currentAgent.type)?.icon ?? 'chat'" />
          </div>
          <div class="agent-meta">
            <h2 class="agent-title">
              {{ currentAgent.name }}
              <t-tag v-if="isPlatformAssistant" theme="primary" variant="dark" size="small">
                平台助理
              </t-tag>
              <t-tag v-else-if="currentAgent.isDefault" theme="primary" variant="light" size="small">
                默认
              </t-tag>
            </h2>
            <p class="agent-desc-sm">
              {{ currentAgent.description || currentAgent.type.toLowerCase() }}
            </p>
          </div>
        </div>
        <div class="header-right">
          <!-- 平台助理：当前工作空间（决定「当前空间」类操作的目标） -->
          <t-dropdown v-if="isPlatformAssistant && platformInfo"
            :options="platformInfo.workspaces.map((w) => ({ value: w.id, content: `${w.name}（${w.role}）` }))"
            trigger="click" :disabled="platformInfo.workspaces.length === 0"
            @click="(d: any) => switchWorkspace(d.value)">
            <span class="workspace-chip" :title="'当前工作空间：' + currentWorkspaceLabel">
              <t-icon name="folder" />
              {{ currentWorkspaceLabel }}
            </span>
          </t-dropdown>

          <button v-if="isPlatformAssistant" class="new-chat-btn" @click="openOperations">
            <t-icon name="history" />
            <span>操作记录</span>
          </button>

          <span class="model-chip" :title="modelTitle">
            <t-icon name="server" />
            {{ displayModel }}
          </span>
          <button v-if="currentSessionId" class="new-chat-btn" @click="createNewSession">
            <t-icon name="add" />
            <span>新对话</span>
          </button>
        </div>
      </header>

      <!-- 空状态 -->
      <template v-if="isEmpty && !loadingMessages">
        <div class="hero-section">
          <div class="hero-content">
            <div class="hero-logo">✦</div>
            <h1 class="hero-title">与 {{ currentAgent?.name }} 对话</h1>
            <p class="hero-subtitle">
              {{ currentAgent?.description || "输入问题开始对话" }}
            </p>

            <div class="prompt-box">
              <div class="prompt-textarea">
                <textarea ref="inputRef" v-model="inputText" placeholder="Ask anything..."
                  :disabled="sending || !currentAgentId" rows="1" @keydown="onKeydown" />
                <button class="send-btn" :class="{ active: canSend }" :disabled="!canSend" @click="send">
                  <t-icon :name="sending ? 'loading' : 'send'" :spin="sending" />
                </button>
              </div>
              <ChatAttachmentBar
                v-if="currentAgentId"
                :attachments="pendingAttachments"
                :disabled="sending || uploading"
                @add="addFiles"
                @remove="removePendingAttachment"
                @preview="openAttachmentPreview"
                @download="handleDownloadAttachment"
              />
            </div>
          </div>
        </div>
      </template>

      <!-- 有消息后：标准聊天布局 -->
      <template v-else>
        <div class="chat-layout">
          <div
            ref="chatContainerRef"
            class="chat-messages"
            @scroll.passive="trackScroll"
          >
            <div v-for="msg in messages" :key="msg.id" class="message-item" :class="msg.role">
              <div class="message-avatar">
                <template v-if="msg.role === 'user'">👤</template>
                <template v-else>✦</template>
              </div>
              <div class="message-body">
                <div class="message-meta">
                  <span class="message-role">
                    {{ msg.role === "user" ? "你" : currentAgent?.name }}
                  </span>
                  <span class="message-time">{{ formatTime(msg.createdAt) }}</span>
                </div>

                <!-- 执行轨迹 trail（只有 assistant 有） -->
                <div v-if="msg.trail && msg.trail.length > 0" class="trail">
                  <div v-for="(step, sIdx) in msg.trail" :key="sIdx" class="trail-step" :class="String(step.type)">
                    <template v-if="step.type === 'thinking'">
                      <span class="step-icon">💭</span>
                      <span class="step-text">{{ (step as any).message }}</span>
                    </template>

                    <template v-else-if="step.type === 'tool_call'">
                      <span class="step-icon">🔧</span>
                      <button class="tool-toggle" @click="toggleTrail(msg.id)">
                        调用 <code>{{ (step as any).tool }}</code>
                      </button>
                      <pre v-if="expandedTrails.has(msg.id)"
                        class="tool-args">{{ formatToolArgs((step as any).args) }}</pre>
                    </template>

                    <template v-else-if="step.type === 'tool_result'">
                      <span class="step-icon">✅</span>
                      <span class="step-text" v-if="(step as any).durationMs">
                        返回结果（{{ (step as any).durationMs }}ms）
                      </span>
                      <button v-else class="tool-toggle" @click="toggleTrail(msg.id)">返回结果</button>
                      <pre v-if="expandedTrails.has(msg.id)"
                        class="tool-result">{{ formatToolResult((step as any).result) }}</pre>
                    </template>

                    <template v-else-if="step.type === 'file'">
                      <span class="step-icon">📄</span>
                      <span class="step-text">
                        已生成文件 {{ (step as any).file?.fileName }}
                      </span>
                    </template>

                    <!-- 平台操作卡片：真实执行结果 + 风险等级 + 目标资源 + 跳转入口 -->
                    <template v-else-if="step.type === 'operation'">
                      <div class="operation-card" :class="stepOperation(step).status.toLowerCase()">
                        <div class="op-head">
                          <t-icon :name="statusMeta(stepOperation(step).status).icon"
                            :class="['op-icon', stepOperation(step).status.toLowerCase()]" />
                          <span class="op-label">{{ stepOperation(step).label }}</span>
                          <t-tag :theme="riskMeta(stepOperation(step).riskLevel).theme" variant="light" size="small">
                            {{ riskMeta(stepOperation(step).riskLevel).label }}
                          </t-tag>
                          <span class="op-status">{{ statusMeta(stepOperation(step).status).label }}</span>
                          <span class="op-duration">{{ stepOperation(step).durationMs }}ms</span>
                        </div>
                        <div class="op-body">
                          <span v-if="stepOperation(step).targetName" class="op-target">
                            目标：{{ stepOperation(step).targetName }}
                          </span>
                          <span class="op-summary">{{ stepOperation(step).summary }}</span>
                        </div>
                        <button v-if="stepOperation(step).link" class="op-link"
                          @click="openOperationLink(stepOperation(step).link)">
                          打开资源
                          <t-icon name="arrow-right" />
                        </button>
                      </div>
                    </template>
                  </div>
                </div>

                <div class="message-content">
                  {{ msg.content || (sending && msg.role === "assistant" ? "" : "") }}
                  <div
                    v-if="sending && msg.role === 'assistant' && !msg.content && (!msg.trail || msg.trail.length === 0)"
                    class="typing">
                    <span></span><span></span><span></span>
                  </div>
                </div>

                <!-- 用户随消息上传的附件（随上下文交给 AI 解析） -->
                <div
                  v-if="msg.role === 'user' && msg.attachments && msg.attachments.length"
                  class="msg-attachments"
                >
                  <div
                    v-for="att in msg.attachments"
                    :key="att.id"
                    class="msg-att"
                    :class="[att.status.toLowerCase(), { clickable: att.status === 'READY' }]"
                    @click="att.status === 'READY' && openAttachmentPreview(att)"
                  >
                    <t-icon
                      :name="fileIcon(att.extension)"
                      :style="{ color: fileColor(att.extension) }"
                    />
                    <span class="msg-att-name">{{ att.originalName }}</span>
                    <span v-if="att.status !== 'READY'" class="msg-att-status">{{
                      att.status === "FAILED" ? "解析失败" : "解析中"
                    }}</span>
                    <t-icon
                      v-if="att.status === 'READY'"
                      name="download"
                      class="msg-att-dl"
                      title="下载"
                      @click.stop="handleDownloadAttachment(att)"
                    />
                  </div>
                </div>

                <!-- 生成的文件卡片（Agent generate_file 产出，可预览 / 下载） -->
                <div v-if="msg.files && msg.files.length > 0" class="file-list">
                  <GeneratedFileCard
                    v-for="file in msg.files"
                    :key="file.id"
                    compact
                    :file="file"
                    @preview="openPreview"
                    @download="handleDownloadFile"
                  />
                </div>
              </div>
            </div>
          </div>

          <div class="chat-input-bottom">
            <div class="prompt-box compact">
              <div class="prompt-textarea">
                <textarea ref="inputRef" v-model="inputText" placeholder="继续对话..."
                  :disabled="sending || !currentAgentId" rows="1" @keydown="onKeydown" />
                <button class="send-btn" :class="{ active: canSend }" :disabled="!canSend" @click="send">
                  <t-icon :name="sending ? 'loading' : 'send'" :spin="sending" />
                </button>
              </div>
              <ChatAttachmentBar
                v-if="currentAgentId"
                :attachments="pendingAttachments"
                :disabled="sending || uploading"
                @add="addFiles"
                @remove="removePendingAttachment"
                @preview="openAttachmentPreview"
                @download="handleDownloadAttachment"
              />
            </div>
          </div>
        </div>
      </template>
    </main>

    <!-- 文件预览抽屉（右侧滑出） -->
    <FilePreviewDrawer v-model:visible="previewVisible" :file="activeFile" />

    <!-- 聊天附件预览抽屉（与生成文件使用不同的后端接口） -->
    <ChatFilePreviewDrawer
      v-model:visible="chatFilePreviewVisible"
      :attachment="activeAttachment"
    />

    <!-- 平台操作记录（审计）：平台助理做过的真实操作，可按资源追溯 -->
    <t-drawer v-model:visible="operationsVisible" header="平台操作记录" size="520px" :footer="false">
      <div class="op-list">
        <t-loading v-if="operationsLoading" size="small" text="加载中…" />
        <div v-else-if="operations.length === 0" class="op-empty">
          还没有操作记录。让平台助理帮你创建或修改资源后，这里会留下审计痕迹。
        </div>
        <div v-for="op in operations" :key="op.id" class="op-item" :class="op.status.toLowerCase()">
          <div class="op-item-head">
            <t-icon :name="statusMeta(op.status).icon" :class="['op-icon', op.status.toLowerCase()]" />
            <span class="op-item-label">{{ op.label }}</span>
            <t-tag :theme="riskMeta(op.riskLevel).theme" variant="light" size="small">
              {{ riskMeta(op.riskLevel).label }}
            </t-tag>
            <span class="op-item-time">{{ formatTime(op.createdAt) }}</span>
          </div>
          <div class="op-item-body">{{ op.summary }}</div>
          <div v-if="op.targetName" class="op-item-target">目标：{{ op.targetName }}</div>
          <button v-if="op.link" class="op-link" @click="openOperationLink(op.link)">
            打开资源
            <t-icon name="arrow-right" />
          </button>
        </div>
      </div>
    </t-drawer>

    <!-- 创建 Agent 对话框 -->
    <t-dialog v-model:visible="showCreateDialog" header="创建 Agent"
      :confirm-btn="{ content: '创建 Agent', theme: 'primary', loading: creatingAgentLoading }" cancel-btn="取消"
      :width="480" @confirm="handleCreateAgent" @close="showCreateDialog = false">
      <div class="create-agent-form">
        <div class="form-item">
          <label>选择类型</label>
          <div class="template-grid">
            <button v-for="tpl in AGENT_TEMPLATES" :key="tpl.type" class="template-card"
              :class="{ active: creatingAgent.type === tpl.type }" @click="creatingAgent.type = tpl.type">
              <t-icon :name="tpl.icon" />
              <div class="tpl-info">
                <span class="tpl-label">{{ tpl.label }}</span>
                <span class="tpl-desc">{{ tpl.description }}</span>
              </div>
            </button>
          </div>
        </div>

        <div class="form-item">
          <label>Agent 名称</label>
          <input v-model="creatingAgent.name" type="text" class="form-input"
            :placeholder="getAgentTemplate(creatingAgent.type)?.defaultName" maxlength="50" />
        </div>

        <div class="form-item">
          <label>描述（可选）</label>
          <textarea v-model="creatingAgent.description" class="form-textarea" placeholder="帮助我分析销售数据并生成结论。" rows="2"
            maxlength="200" />
        </div>

      </div>
    </t-dialog>
  </div>
</template>

<style scoped lang="less">
@import "../../styles/variables.less";

.chat-page {
  height: 100%;
  width: 100%;
  display: flex;
  position: relative;
  overflow: hidden;
}

// ===========================================================================
// Agent 侧边栏
// ===========================================================================

.agent-sidebar {
  width: 280px;
  flex-shrink: 0;
  background: @color-bg-surface;
  border-right: 1px solid @color-border;
  display: flex;
  flex-direction: column;
  transition: width @duration-normal @ease-standard;
  position: relative;

  &.collapsed {
    width: 0;
    overflow: visible;

    .sidebar-content {
      display: none;
    }
  }
}

.sidebar-toggle {
  position: absolute;
  top: 12px;
  right: -14px;
  z-index: 10;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1px solid @color-border;
  background: @color-bg-surface;
  color: @color-text-tertiary;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  transition: all @duration-fast;

  &:hover {
    color: @primary;
    border-color: @primary;
    box-shadow: @shadow-sm;
  }
}

.sidebar-content {
  flex: 1;
  overflow-y: auto;
  padding: @space-3;
  display: flex;
  flex-direction: column;
  gap: @space-4;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: @space-2;

  .section-title {
    font-size: 11px;
    font-weight: 600;
    color: @color-text-tertiary;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .create-btn {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 3px 8px;
    border: 1px solid @color-border;
    border-radius: @radius-pill;
    background: transparent;
    color: @color-text-secondary;
    font-size: 11px;
    cursor: pointer;
    transition: all @duration-fast;

    &:hover {
      background: @primary-light;
      color: @primary;
      border-color: @primary;
    }

    &.text-only {
      border: none;
      padding: 2px;
    }
  }
}

// Agent 列表
.agent-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.agent-item {
  display: flex;
  align-items: center;
  gap: @space-2;
  padding: @space-2 @space-3;
  border-radius: @radius-md;
  background: transparent;
  border: none;
  cursor: pointer;
  width: 100%;
  text-align: left;
  transition: all @duration-fast;
  position: relative;

  &:hover {
    background: @color-bg-hover;
  }

  &.active {
    background: @primary-light;
  }

  .agent-avatar {
    width: 32px;
    height: 32px;
    border-radius: @radius-md;
    background: @color-bg-hover;
    color: @color-text-secondary;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    flex-shrink: 0;

    &.general {
      background: rgba(99, 102, 241, 0.1);
      color: #6366f1;
    }

    &.knowledge {
      background: rgba(34, 197, 94, 0.1);
      color: #22c55e;
    }

    &.workflow {
      background: rgba(249, 115, 22, 0.1);
      color: #f97316;
    }

    &.tool {
      background: rgba(236, 72, 153, 0.1);
      color: #ec4899;
    }

    &.custom {
      background: rgba(139, 92, 246, 0.1);
      color: #8b5cf6;
    }

    &.lg {
      width: 40px;
      height: 40px;
      font-size: 20px;
      border-radius: @radius-lg;
    }
  }

  .agent-info {
    flex: 1;
    min-width: 0;

    .agent-name {
      font-size: @font-sm;
      font-weight: 600;
      color: @color-text;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .agent-desc {
      font-size: 11px;
      color: @color-text-tertiary;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }

  .agent-delete {
    font-size: 12px;
    color: @color-text-tertiary;
    opacity: 0;
    transition: opacity @duration-fast;

    .agent-item:hover & {
      opacity: 1;
    }
  }

  .default-tag {
    flex-shrink: 0;
  }
}

.agent-empty {
  padding: @space-4;
  text-align: center;
  color: @color-text-tertiary;
  font-size: @font-sm;
  display: flex;
  flex-direction: column;
  gap: @space-3;

  .create-btn {
    margin: 0 auto;
    display: inline-flex;
    align-items: center;
    gap: @space-1;
    padding: @space-2 @space-3;
    background: @primary;
    color: #fff;
    border: none;
    border-radius: @radius-md;
    font-size: @font-sm;
    cursor: pointer;
  }
}

// 会话列表
.session-section {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.session-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
}

.session-item {
  display: flex;
  align-items: center;
  border-radius: @radius-md;
  background: transparent;
  transition: all @duration-fast;
  position: relative;

  .session-main {
    display: flex;
    align-items: center;
    gap: @space-2;
    padding: @space-2 @space-3;
    border: none;
    background: transparent;
    cursor: pointer;
    width: 100%;
    text-align: left;
  }

  &:hover {
    background: @color-bg-hover;

    .session-delete {
      opacity: 1;
      pointer-events: auto;
    }

    .session-time {
      opacity: 0;
    }
  }

  &.active {
    background: @color-bg-hover;

    .session-delete {
      opacity: 1;
      pointer-events: auto;
    }

    .session-time {
      opacity: 0;
    }
  }

  .session-icon {
    font-size: 14px;
    color: @color-text-tertiary;
    flex-shrink: 0;
  }

  .session-title {
    flex: 1;
    font-size: @font-sm;
    color: @color-text-secondary;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .session-time {
    font-size: 10px;
    color: @color-text-tertiary;
    flex-shrink: 0;
    transition: opacity @duration-fast;
  }

  .session-delete {
    opacity: 0;
    pointer-events: none;
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    border-radius: @radius-sm;
    color: @color-text-tertiary;
    cursor: pointer;
    margin-right: 4px;
    transition: all @duration-fast;

    &:hover {
      background: rgba(239, 68, 68, 0.1);
      color: #ef4444;
      opacity: 1 !important;
    }

    .t-icon {
      font-size: 12px;
    }
  }
}

.session-empty {
  padding: @space-4;
  text-align: center;
  font-size: 12px;
  color: @color-text-tertiary;
}

// ===========================================================================
// 聊天主体
// ===========================================================================

.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: @space-4 @space-8;
  border-bottom: 1px solid @color-border;
  background: @color-bg-surface;
  flex-shrink: 0;

  .header-left {
    display: flex;
    align-items: center;
    gap: @space-3;
  }

  .agent-meta {
    .agent-title {
      font-size: @font-lg;
      font-weight: 600;
      color: @color-text;
      margin: 0;
      display: flex;
      align-items: center;
      gap: @space-2;
    }

    .agent-desc-sm {
      font-size: @font-sm;
      color: @color-text-tertiary;
      margin: 2px 0 0;
    }
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: @space-2;
  }

  .model-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    font-size: 11px;
    color: @color-text-secondary;
    background: @color-bg-hover;
    border-radius: @radius-pill;
  }

  .new-chat-btn {
    display: inline-flex;
    align-items: center;
    gap: @space-1;
    padding: 6px 12px;
    background: @primary;
    color: #fff;
    border: none;
    border-radius: @radius-md;
    font-size: @font-sm;
    cursor: pointer;
    transition: all @duration-fast;

    &:hover {
      background: @primary-hover;
    }
  }
}

// Hero 空状态
.hero-section {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: @space-12 @space-8;
}

.hero-content {
  width: 100%;
  max-width: 680px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: @space-6;
  animation: fade-slide-up @duration-normal @ease-out;
}

.hero-logo {
  width: 48px;
  height: 48px;
  border-radius: @radius-xl;
  background: linear-gradient(135deg, @primary 0%, lighten(@primary, 8%) 100%);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  font-weight: 700;
  box-shadow: 0 4px 16px @primary-shadow;
}

.hero-title {
  font-size: @font-hero;
  font-weight: 700;
  color: @color-text;
  letter-spacing: -0.02em;
  margin: 0;
  text-align: center;
}

.hero-subtitle {
  font-size: @font-base;
  color: @color-text-secondary;
  text-align: center;
  margin: 0;
}

// Prompt box（复用 chat 页面的样式）
.prompt-box {
  width: 100%;
  background: @color-bg-surface;
  border: 1px solid @color-border;
  border-radius: @radius-card;
  box-shadow: @shadow-card;
  padding: @space-3;
  transition: border-color @duration-fast, box-shadow @duration-fast;

  &:focus-within {
    border-color: @primary;
    box-shadow: 0 0 0 3px @primary-glow, @shadow-card;
  }

  &.compact {
    border-radius: @radius-lg;
    box-shadow: @shadow-md;
  }
}

.prompt-textarea {
  position: relative;

  textarea {
    width: 100%;
    border: none;
    outline: none;
    resize: none;
    padding: @space-3 @space-12 @space-3 @space-3;
    font-size: @font-base;
    font-family: inherit;
    color: @color-text;
    background: transparent;
    line-height: 1.6;
    max-height: 200px;

    &::placeholder {
      color: @color-text-tertiary;
    }
  }

  .send-btn {
    position: absolute;
    right: 8px;
    bottom: 8px;
    width: 36px;
    height: 36px;
    border: none;
    border-radius: @radius-md;
    background: @color-bg-hover;
    color: @color-text-tertiary;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all @duration-fast;
    font-size: 16px;

    &.active {
      background: @primary;
      color: #fff;
      box-shadow: 0 2px 8px @primary-shadow;

      &:hover {
        background: @primary-hover;
      }
    }

    &:disabled {
      cursor: not-allowed;
    }
  }
}

// 聊天布局
.chat-layout {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: @space-8 @space-12;
  display: flex;
  flex-direction: column;
  gap: @space-6;
}

.message-item {
  display: flex;
  gap: @space-4;
  max-width: 800px;
  margin: 0 auto;
  width: 100%;
  animation: fade-slide-up @duration-normal @ease-out;

  &.user {
    flex-direction: row-reverse;

    .message-body {
      align-items: flex-end;
    }

    .message-content {
      background: @primary;
      color: #fff;
    }
  }

  .message-avatar {
    width: 36px;
    height: 36px;
    border-radius: @radius-lg;
    background: @color-bg-hover;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    flex-shrink: 0;

    .assistant & {
      background: linear-gradient(135deg, @primary 0%, lighten(@primary, 8%) 100%);
      color: #fff;
    }
  }

  .message-body {
    display: flex;
    flex-direction: column;
    gap: @space-1;
    max-width: 70%;
    min-width: 0;
  }

  .message-meta {
    display: flex;
    gap: @space-2;
    font-size: @font-xs;
    color: @color-text-tertiary;

    .message-role {
      font-weight: 500;
      color: @color-text-secondary;
    }
  }

  .message-content {
    padding: @space-3 @space-4;
    background: @color-bg-surface;
    border: 1px solid @color-border;
    border-radius: @radius-lg;
    line-height: 1.7;
    font-size: @font-base;
    white-space: pre-wrap;
    word-break: break-word;
    width: 100%;
    min-height: 20px;

    .typing {
      display: flex;
      gap: 4px;
      padding: @space-2 0;

      span {
        width: 8px;
        height: 8px;
        background: @color-text-tertiary;
        border-radius: 50%;
        animation: typing-bounce 1.4s infinite ease-in-out both;

        &:nth-child(1) {
          animation-delay: -0.32s;
        }

        &:nth-child(2) {
          animation-delay: -0.16s;
        }
      }
    }
  }

  // 用户消息中的附件展示
  .msg-attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: @space-2;
  }

  .msg-att {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 240px;
    padding: 4px 8px;
    border-radius: 8px;
    background: @color-bg-surface;
    border: 1px solid @color-border;
    font-size: 12px;
    color: @color-text-secondary;

    &.failed {
      border-color: #f0a3a3;
      background: #fff1f0;
    }

    &.clickable {
      cursor: pointer;

      &:hover {
        border-color: @primary;
      }
    }

    .msg-att-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 140px;
    }

    .msg-att-status {
      flex-shrink: 0;
      color: #71717a;
    }

    .msg-att-dl {
      flex-shrink: 0;
      cursor: pointer;
      color: #71717a;

      &:hover {
        color: @primary;
      }
    }
  }
}

// Trail 样式（复用）
.trail {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: @space-2;
  margin-bottom: @space-1;
  width: 100%;

  .trail-step {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-radius: 6px;
    font-size: 12px;

    &.thinking {
      color: @color-text-tertiary;
      background: rgba(0, 0, 0, 0.03);
    }

    &.tool_call {
      background: @primary-light;
      color: @primary;
    }

    &.tool_result {
      background: rgba(34, 197, 94, 0.08);
      color: @color-success;
    }

    /* 平台操作卡片自己带边框与内边距，这里不要额外的行内样式 */
    &.operation {
      display: block;
      padding: 0;
      background: transparent;
    }

    .step-icon {
      font-size: 14px;
      flex-shrink: 0;
    }

    code {
      font-family: "Menlo", "Consolas", monospace;
      background: rgba(0, 0, 0, 0.06);
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 11px;
    }

    .tool-toggle {
      background: transparent;
      border: none;
      color: inherit;
      cursor: pointer;
      font-size: 12px;
      padding: 2px 6px;
      border-radius: 4px;

      &:hover {
        background: rgba(0, 0, 0, 0.06);
      }
    }

    .tool-args,
    .tool-result {
      margin: 2px 0 0 20px;
      padding: 8px 10px;
      border-radius: 6px;
      background: rgba(0, 0, 0, 0.04);
      font-size: 11px;
      font-family: "Menlo", "Consolas", monospace;
      max-height: 250px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
      width: 100%;
    }
  }
}

// ===========================================================================
// 平台助理：操作卡片 / 操作记录抽屉
// ===========================================================================

.workspace-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid @color-border;
  background: @color-bg-surface;
  color: @color-text-secondary;
  font-size: 12px;
  cursor: pointer;
  max-width: 180px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;

  &:hover {
    border-color: @primary;
    color: @primary;
  }
}

.operation-card {
  width: 100%;
  border: 1px solid @color-border;
  border-left: 3px solid @color-success;
  border-radius: 8px;
  background: @color-bg-surface;
  padding: @space-2 @space-3;
  display: flex;
  flex-direction: column;
  gap: 4px;

  &.failed {
    border-left-color: @color-error;
  }

  &.denied {
    border-left-color: @color-warning;
  }

  .op-head {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .op-icon {
    font-size: 14px;

    &.success {
      color: @color-success;
    }

    &.failed {
      color: @color-error;
    }

    &.denied {
      color: @color-warning;
    }
  }

  .op-label {
    font-weight: 600;
    font-size: 12px;
    color: @color-text;
  }

  .op-status {
    font-size: 11px;
    color: @color-text-secondary;
  }

  .op-duration {
    font-size: 11px;
    color: @color-text-tertiary;
    margin-left: auto;
  }

  .op-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 12px;
    color: @color-text-secondary;
    word-break: break-word;
  }

  .op-target {
    color: @color-text;
  }

  .op-summary {
    color: @color-text-secondary;
  }
}

.op-link {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  border: none;
  background: transparent;
  color: @primary;
  font-size: 12px;
  cursor: pointer;
  padding: 2px 0;

  &:hover {
    text-decoration: underline;
  }
}

.op-list {
  display: flex;
  flex-direction: column;
  gap: @space-3;

  .op-empty {
    color: @color-text-tertiary;
    font-size: 13px;
    padding: @space-6 0;
    text-align: center;
  }

  .op-item {
    border: 1px solid @color-border;
    border-left: 3px solid @color-success;
    border-radius: 8px;
    padding: @space-3;
    display: flex;
    flex-direction: column;
    gap: 4px;

    &.failed {
      border-left-color: @color-error;
    }

    &.denied {
      border-left-color: @color-warning;
    }
  }

  .op-item-head {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .op-item-label {
    font-weight: 600;
    font-size: 13px;
    color: @color-text;
  }

  .op-item-time {
    font-size: 11px;
    color: @color-text-tertiary;
    margin-left: auto;
  }

  .op-item-body {
    font-size: 12px;
    color: @color-text-secondary;
    word-break: break-word;
  }

  .op-item-target {
    font-size: 12px;
    color: @color-text;
  }

  .op-icon {
    font-size: 14px;

    &.success {
      color: @color-success;
    }

    &.failed {
      color: @color-error;
    }

    &.denied {
      color: @color-warning;
    }
  }
}

.chat-input-bottom {
  padding: @space-4 @space-12 @space-8;
  max-width: 800px;
  margin: 0 auto;  width: 100%;
  flex-shrink: 0;
}

// ===========================================================================
// 创建 Agent 对话框
// ===========================================================================

.create-agent-form {
  display: flex;
  flex-direction: column;
  gap: @space-5;
  padding: @space-2 0;

  .form-item {
    display: flex;
    flex-direction: column;
    gap: @space-2;

    label {
      font-size: @font-sm;
      font-weight: 500;
      color: @color-text-secondary;
    }
  }

  .template-grid {
    display: flex;
    flex-direction: column;
    gap: @space-2;
  }

  .template-card {
    display: flex;
    align-items: flex-start;
    gap: @space-3;
    padding: @space-3;
    border: 1px solid @color-border;
    border-radius: @radius-lg;
    background: transparent;
    cursor: pointer;
    text-align: left;
    transition: all @duration-fast;

    &:hover {
      border-color: @primary;
      background: @primary-light;
    }

    &.active {
      border-color: @primary;
      background: @primary-light;
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
    }

    >t-icon {
      font-size: 18px;
      color: @color-text-secondary;
      flex-shrink: 0;
      margin-top: 2px;
    }

    .tpl-info {
      display: flex;
      flex-direction: column;
      gap: 2px;

      .tpl-label {
        font-size: @font-sm;
        font-weight: 600;
        color: @color-text;
      }

      .tpl-desc {
        font-size: 12px;
        color: @color-text-tertiary;
        line-height: 1.4;
      }
    }
  }

  .form-input,
  .form-textarea {
    width: 100%;
    padding: @space-2 @space-3;
    border: 1px solid @color-border;
    border-radius: @radius-md;
    background: @color-bg-surface;
    font-size: @font-base;
    color: @color-text;
    font-family: inherit;
    outline: none;
    transition: all @duration-fast;

    &:focus {
      border-color: @primary;
      box-shadow: 0 0 0 3px @primary-glow;
    }
  }

  .form-textarea {
    resize: vertical;
    min-height: 60px;
  }
}
</style>
