<script setup lang="ts">
import { ref, reactive, onMounted, computed } from "vue";
import { MessagePlugin, DialogPlugin } from "tdesign-vue-next";
import {
  getLlmConfigs,
  createLlmConfig,
  updateLlmConfig,
  removeLlmConfig,
  testLlmConfig,
  testSavedLlmConfig,
  fetchRemoteLlmModels,
  addLlmModels,
  removeLlmModel,
  updateLlmModel,
  setDefaultLlmModel,
  verifyLlmModel,
} from "@/api/provider";
import {
  type LlmProviderConfig,
  type LlmModel,
  type LlmProviderType,
  type ModelCapability,
  type LlmConfigStatus,
  PROVIDER_LABELS,
  CAPABILITY_LABELS,
  CAPABILITY_TIPS,
} from "@/types/provider";

const configs = ref<LlmProviderConfig[]>([]);
const loading = ref(false);

const providerOptions = computed(() =>
  (Object.keys(PROVIDER_LABELS) as LlmProviderType[]).map((p) => ({
    value: p,
    label: PROVIDER_LABELS[p],
  })),
);
const capabilityOptions = computed(() =>
  (Object.keys(CAPABILITY_LABELS) as ModelCapability[]).map((c) => ({
    value: c,
    label: CAPABILITY_LABELS[c],
    tips: CAPABILITY_TIPS[c],
  })),
);

const modalityOptions = [
  { value: "text", label: "文本" },
  { value: "image", label: "图片" },
  { value: "audio", label: "音频" },
];

const statusMeta: Record<LlmConfigStatus, { theme: string; label: string }> = {
  CONNECTED: { theme: "success", label: "已连接" },
  ERROR: { theme: "danger", label: "连接失败" },
  DISABLED: { theme: "warning", label: "已停用" },
  UNKNOWN: { theme: "default", label: "未测试" },
};

// ===================== 配置 增 / 改 对话框 =====================
const dialogVisible = ref(false);
const editingId = ref<string | null>(null);
const saving = ref(false);
const testing = ref(false);
const testResult = ref<{ ok: boolean; models: string[]; error?: string } | null>(
  null,
);

const defaultBaseUrl: Record<LlmProviderType, string> = {
  ollama: "http://localhost:11434",
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  "openai-compatible": "",
};

const form = reactive({
  name: "",
  provider: "ollama" as LlmProviderType,
  baseUrl: defaultBaseUrl.ollama,
  apiKey: "",
  modelId: "",
  displayName: "",
  capabilities: ["CHAT", "STREAM"] as ModelCapability[],
});

function resetForm() {
  form.name = "";
  form.provider = "ollama";
  form.baseUrl = defaultBaseUrl.ollama;
  form.apiKey = "";
  form.modelId = "";
  form.displayName = "";
  form.capabilities = ["CHAT", "STREAM"];
}

function openCreate() {
  editingId.value = null;
  resetForm();
  testResult.value = null;
  dialogVisible.value = true;
}

function openEdit(cfg: LlmProviderConfig) {
  editingId.value = cfg.id;
  form.name = cfg.name;
  form.provider = cfg.provider;
  form.baseUrl = cfg.baseUrl || defaultBaseUrl[cfg.provider] || "";
  form.apiKey = "";
  form.modelId = "";
  form.displayName = "";
  form.capabilities = ["CHAT", "STREAM"];
  testResult.value = null;
  dialogVisible.value = true;
}

function onProviderChange(p: LlmProviderType) {
  form.baseUrl = defaultBaseUrl[p];
}

// ===================== 模型 编辑对话框 =====================
const modelDialogVisible = ref(false);
const editingModel = ref<LlmModel | null>(null);
const savingModel = ref(false);
const modelForm = reactive({
  displayName: "",
  capabilities: [] as ModelCapability[],
  inputModalities: ["text"] as string[],
  outputModalities: ["text"] as string[],
  embeddingDimensions: null as number | null,
  maxInputTokens: null as number | null,
});

/** 是否勾选了向量化能力 —— 勾选后才显示「向量维度」 */
const modelIsEmbedding = computed(() =>
  modelForm.capabilities.includes("EMBEDDING"),
);

function openEditModel(m: LlmModel) {
  editingModel.value = m;
  modelForm.displayName = m.displayName || "";
  modelForm.capabilities = [...m.capabilities];
  modelForm.inputModalities = [...(m.inputModalities ?? ["text"])];
  modelForm.outputModalities = [...(m.outputModalities ?? ["text"])];
  modelForm.embeddingDimensions = m.embeddingDimensions ?? null;
  modelForm.maxInputTokens = m.maxInputTokens ?? null;
  modelDialogVisible.value = true;
}

async function onSaveModel() {
  if (!editingModel.value) return;
  savingModel.value = true;
  try {
    await updateLlmModel(editingModel.value.id, {
      displayName: modelForm.displayName || undefined,
      capabilities: modelForm.capabilities,
      inputModalities: modelForm.inputModalities as never,
      outputModalities: modelForm.outputModalities as never,
      // 维度 / token 上限建议用「验证模型」实测写入，这里允许手工修正
      embeddingDimensions: modelIsEmbedding.value
        ? modelForm.embeddingDimensions
        : null,
      maxInputTokens: modelForm.maxInputTokens,
    });
    MessagePlugin.success("已更新模型");
    modelDialogVisible.value = false;
    await fetchConfigs();
  } catch {
    /* 错误提示由拦截器处理 */
  } finally {
    savingModel.value = false;
  }
}

// ===================== 模型实测验证 =====================
const verifyingId = ref<string | null>(null);

async function onVerifyModel(model: LlmModel) {
  verifyingId.value = model.id;
  try {
    const res = await verifyLlmModel(model.id);
    if (res.ok) {
      MessagePlugin.success(
        res.dimensions
          ? `验证通过：实际输出 ${res.dimensions} 维（${res.latencyMs}ms）`
          : `验证通过（${res.latencyMs}ms）`,
      );
    } else {
      MessagePlugin.error(`验证失败：${res.error || "未知错误"}`);
    }
    await fetchConfigs();
  } catch {
    /* 错误提示由拦截器处理 */
  } finally {
    verifyingId.value = null;
  }
}

// ===================== 手动添加单个模型 =====================
const addModelDialogVisible = ref(false);
const addModelSaving = ref(false);
const addModelConfigId = ref<string | null>(null);
const addModelConfigName = ref("");
const addModelForm = reactive({
  modelId: "",
  displayName: "",
  capabilities: ["CHAT", "STREAM"] as ModelCapability[],
});

function openAddModel(cfg: LlmProviderConfig) {
  addModelConfigId.value = cfg.id;
  addModelConfigName.value = cfg.name;
  addModelForm.modelId = "";
  addModelForm.displayName = "";
  addModelForm.capabilities = ["CHAT", "STREAM"];
  addModelDialogVisible.value = true;
}

async function onAddModelSubmit() {
  const modelId = addModelForm.modelId.trim();
  if (!modelId) {
    MessagePlugin.warning("请填写模型 ID");
    return;
  }
  if (!addModelConfigId.value) return;
  addModelSaving.value = true;
  try {
    await addLlmModels(addModelConfigId.value, {
      modelIds: [modelId], // 只添加用户填写的这一个
      capabilities: addModelForm.capabilities,
    });
    MessagePlugin.success(`已添加模型「${modelId}」`);
    addModelDialogVisible.value = false;
    await fetchConfigs();
  } catch {
    /* 错误提示由拦截器处理 */
  } finally {
    addModelSaving.value = false;
  }
}

// ===================== 获取模型（表格勾选弹窗） =====================
const remoteDialogVisible = ref(false);
const remoteLoading = ref(false);
const remoteSaving = ref(false);
const remoteConfigId = ref<string | null>(null);
const remoteConfigName = ref("");
const remoteKeyword = ref("");
const remoteRows = ref<{ modelId: string; existing: boolean }[]>([]);
const remoteSelected = ref<string[]>([]);

const remoteColumns = [
  // 已添加的模型（row.existing）禁用勾选框，避免重复添加
  { colKey: "row-select", type: "multiple", width: 48, disabled: ({ row }: { row: { existing?: boolean } }) => Boolean(row.existing) },
  { colKey: "modelId", title: "模型 ID", minWidth: 240 },
  { colKey: "status", title: "状态", width: 100 },
];

const filteredRemoteRows = computed(() => {
  const kw = remoteKeyword.value.trim().toLowerCase();
  if (!kw) return remoteRows.value;
  return remoteRows.value.filter((r) => r.modelId.toLowerCase().includes(kw));
});

async function onFetchModels(cfg: LlmProviderConfig) {
  remoteConfigId.value = cfg.id;
  remoteConfigName.value = cfg.name;
  remoteKeyword.value = "";
  remoteSelected.value = [];
  remoteRows.value = [];
  remoteDialogVisible.value = true;
  remoteLoading.value = true;
  try {
    const res = await fetchRemoteLlmModels(cfg.id);
    const existing = new Set(res.existing ?? []);
    remoteRows.value = (res.models ?? []).map((modelId) => ({
      modelId,
      existing: existing.has(modelId),
    }));
    if (remoteRows.value.length === 0) {
      MessagePlugin.warning("未获取到任何模型，可改用「添加模型」手动填写 ID");
    }
  } catch {
    remoteDialogVisible.value = false;
  } finally {
    remoteLoading.value = false;
  }
}

function onRemoteSelectChange(selected: (string | number)[]) {
  remoteSelected.value = selected.map(String);
}

function toggleSelectAll() {
  // 跳过已添加（existing）的行，它们的勾选框已被禁用
  const ids = filteredRemoteRows.value.filter((r) => !r.existing).map((r) => r.modelId);
  const allSelected = ids.length > 0 && ids.every((id) => remoteSelected.value.includes(id));
  remoteSelected.value = allSelected
    ? remoteSelected.value.filter((id) => !ids.includes(id))
    : [...new Set([...remoteSelected.value, ...ids])];
}

async function onAddSelectedModels() {
  if (!remoteConfigId.value) return;
  if (remoteSelected.value.length === 0) {
    MessagePlugin.warning("请先勾选要添加的模型");
    return;
  }
  remoteSaving.value = true;
  try {
    // 防御性过滤：已添加（existing）的模型不应被提交
    const toAdd = remoteSelected.value.filter((id) => {
      const row = remoteRows.value.find((r) => r.modelId === id);
      return row && !row.existing;
    });
    if (toAdd.length === 0) {
      MessagePlugin.warning("请先勾选要添加的模型");
      return;
    }
    await addLlmModels(remoteConfigId.value, {
      modelIds: toAdd,
      capabilities: ["CHAT", "STREAM"],
    });
    MessagePlugin.success(`已添加 ${toAdd.length} 个模型`);
    remoteDialogVisible.value = false;
    await fetchConfigs();
  } catch {
    /* 错误提示由拦截器处理 */
  } finally {
    remoteSaving.value = false;
  }
}

// ===================== 数据加载 =====================
async function fetchConfigs() {
  loading.value = true;
  try {
    configs.value = await getLlmConfigs();
  } catch {
    MessagePlugin.error("加载模型配置失败");
  } finally {
    loading.value = false;
  }
}

// ===================== 操作 =====================
async function onTest() {
  if (!form.name && form.provider !== "ollama" && !form.apiKey) {
    // 测试不强制要求名称，但云端需要 key
  }
  if (form.provider !== "ollama" && !form.apiKey) {
    MessagePlugin.warning("该提供商需要填写 API Key 才能测试");
    return;
  }
  testing.value = true;
  testResult.value = null;
  try {
    const res = await testLlmConfig({
      provider: form.provider,
      baseUrl: form.baseUrl || undefined,
      apiKey: form.apiKey || undefined,
      modelId: form.modelId || undefined,
    });
    testResult.value = res;
    if (res.ok) MessagePlugin.success("连接成功");
    else MessagePlugin.error(`连接失败：${res.error || ""}`);
  } catch {
    MessagePlugin.error("测试请求失败");
  } finally {
    testing.value = false;
  }
}

async function onSubmit() {
  if (!form.name.trim()) {
    MessagePlugin.warning("请填写配置名称");
    return;
  }
  if (form.provider !== "ollama" && !form.apiKey) {
    MessagePlugin.warning("该提供商需要 API Key");
    return;
  }
  saving.value = true;
  try {
    if (editingId.value) {
      const withModel = !!form.modelId.trim();
      await updateLlmConfig(editingId.value, {
        name: form.name,
        baseUrl: form.baseUrl || undefined,
        apiKey: form.apiKey || undefined,
        // 填了 modelId 就只添加 / 更新这一个模型
        modelId: withModel ? form.modelId.trim() : undefined,
        displayName: withModel ? form.displayName.trim() || undefined : undefined,
        capabilities: withModel ? form.capabilities : undefined,
      });
      MessagePlugin.success(withModel ? "已更新配置并添加模型" : "已更新配置");
    } else {
      await createLlmConfig({
        name: form.name,
        provider: form.provider,
        baseUrl: form.baseUrl || undefined,
        apiKey: form.apiKey || undefined,
        modelId: form.modelId || undefined,
        displayName: form.displayName || undefined,
        capabilities: form.capabilities,
      });
      MessagePlugin.success("已添加模型配置");
    }
    dialogVisible.value = false;
    await fetchConfigs();
  } catch {
    /* 错误提示由拦截器处理 */
  } finally {
    saving.value = false;
  }
}

async function onTestSaved(cfg: LlmProviderConfig) {
  try {
    const res = await testSavedLlmConfig(cfg.id);
    if (res.ok) MessagePlugin.success(`「${cfg.name}」连接成功`);
    else MessagePlugin.error(`「${cfg.name}」连接失败：${res.error || ""}`);
    await fetchConfigs();
  } catch {
    /* ignore */
  }
}

function onDeleteModel(model: LlmModel) {
  const dialog = DialogPlugin.confirm({
    header: "删除模型",
    body: `确定删除模型「${model.displayName || model.modelId}」？`,
    confirmBtn: { content: "删除", theme: "danger" },
    onConfirm: async () => {
      await removeLlmModel(model.id);
      MessagePlugin.success("已删除模型");
      dialog.destroy();
      await fetchConfigs();
    },
  });
}

function onDelete(cfg: LlmProviderConfig) {
  const dialog = DialogPlugin.confirm({
    header: "删除确认",
    body: `确定删除配置「${cfg.name}」？其下的模型也会一并删除。`,
    confirmBtn: { content: "删除", theme: "danger" },
    onConfirm: async () => {
      await removeLlmConfig(cfg.id);
      MessagePlugin.success("已删除");
      dialog.destroy();
      await fetchConfigs();
    },
  });
}

async function onSetDefault(model: LlmModel) {
  try {
    await setDefaultLlmModel(model.id);
    MessagePlugin.success("已设为默认模型");
    await fetchConfigs();
  } catch {
    /* ignore */
  }
}

async function onToggleEnabled(model: LlmModel, val: boolean) {
  try {
    await updateLlmModel(model.id, { enabled: val });
    MessagePlugin.success(val ? "已启用" : "已停用");
    await fetchConfigs();
  } catch {
    /* ignore */
  }
}

const modelsColumns = [
  { colKey: "modelId", title: "模型 ID", minWidth: 160 },
  { colKey: "displayName", title: "显示名", minWidth: 120 },
  { colKey: "capabilities", title: "能力", minWidth: 200 },
  { colKey: "dimensions", title: "向量维度", width: 100 },
  { colKey: "isDefault", title: "默认", width: 80 },
  { colKey: "enabled", title: "启用", width: 90 },
  { colKey: "actions", title: "操作", width: 280, align: "right" as const },
];

onMounted(fetchConfigs);
</script>

<template>
  <div class="page-container">
    <div class="page-header">
      <div>
        <h2 class="page-title">模型管理</h2>
        <p class="page-subtitle">
          配置你自己的大模型提供商与 API Key，在 AI 对话、工作流与 Agent 中统一使用。
        </p>
      </div>
      <t-button theme="primary" @click="openCreate">
        <template #icon><t-icon name="add" /></template>
        添加模型
      </t-button>
    </div>

    <t-loading :loading="loading" text="加载中..." :delay="200">
      <div v-if="configs.length === 0 && !loading" class="empty-state">
        <t-icon name="server" size="48px" />
        <p>还没有任何模型配置，点击「添加模型」开始接入 Ollama / OpenAI / DeepSeek 等。</p>
      </div>

      <div v-else class="config-list">
        <t-card v-for="cfg in configs" :key="cfg.id" class="config-card" :bordered="true">
          <div class="config-head">
            <div class="config-title">
              <span class="config-name">{{ cfg.name }}</span>
              <t-tag size="small" variant="light" theme="primary">{{
                PROVIDER_LABELS[cfg.provider]
                }}</t-tag>
              <t-tag size="small" variant="light" :theme="statusMeta[cfg.status].theme">{{ statusMeta[cfg.status].label
                }}</t-tag>
            </div>
            <div class="config-actions">
              <t-button size="small" variant="outline" :disabled="cfg.status === 'DISABLED'"
                @click="onTestSaved(cfg)">测试连接</t-button>
              <t-button size="small" variant="outline" :disabled="cfg.status === 'DISABLED'"
                @click="onFetchModels(cfg)">获取模型</t-button>
              <t-button size="small" variant="outline" theme="primary" @click="openAddModel(cfg)">手动添加模型</t-button>
              <t-button size="small" variant="outline" @click="openEdit(cfg)">编辑</t-button>
              <t-button size="small" theme="danger" variant="outline" @click="onDelete(cfg)">删除</t-button>
            </div>
          </div>

          <div class="config-meta">
            <span class="meta-item"><span class="meta-label">Base URL：</span>{{ cfg.baseUrl || "（默认）" }}</span>
            <span class="meta-item"><span class="meta-label">API Key：</span>{{ cfg.apiKeyMasked || "（无）" }}</span>
          </div>

          <t-alert v-if="cfg.status === 'ERROR' && cfg.lastError" theme="error" :message="`最近错误：${cfg.lastError}`"
            class="config-error" />

          <div class="models-section">
            <div class="models-title">
              模型（{{ cfg.models.length }}）<span class="models-hint">可在此设置默认模型</span>
            </div>
            <t-table v-if="cfg.models.length" :data="cfg.models" :columns="modelsColumns" row-key="id" size="small"
              hover>
              <template #capabilities="{ row }">
                <t-tag v-for="cap in row.capabilities" :key="cap" size="small" variant="light" theme="default"
                  class="cap-tag">{{ CAPABILITY_LABELS[cap as ModelCapability] }}</t-tag>
              </template>
              <template #dimensions="{ row }">
                <t-tag v-if="row.embeddingDimensions" size="small" variant="light"
                  :theme="row.isVerified ? 'success' : 'warning'">{{ row.embeddingDimensions }}</t-tag>
                <span v-else class="muted">—</span>
              </template>
              <template #isDefault="{ row }">
                <t-tag v-if="row.isDefault" size="small" theme="success" variant="light">默认</t-tag>
                <span v-else class="muted">—</span>
              </template>
              <template #enabled="{ row }">
                <t-switch :value="row.enabled" size="small" @change="(val: boolean) => onToggleEnabled(row, val)" />
              </template>
              <template #actions="{ row }">
                <t-button v-if="!row.isDefault" size="small" variant="text" theme="primary" :disabled="!row.enabled"
                  @click="onSetDefault(row)">设为默认</t-button>
                <t-button size="small" variant="text" theme="primary" :loading="verifyingId === row.id"
                  @click="onVerifyModel(row)">验证</t-button>
                <t-button size="small" variant="text" theme="default" @click="openEditModel(row)">编辑</t-button>
                <t-button size="small" variant="text" theme="danger" @click="onDeleteModel(row)">删除</t-button>
              </template>
            </t-table>
            <p v-else class="models-empty">
              暂无模型，可点「添加模型」手动填写模型 ID，或点「获取模型」从远端勾选。
            </p>
          </div>
        </t-card>
      </div>
    </t-loading>

    <!-- 添加 / 编辑 配置对话框 -->
    <t-dialog v-model:visible="dialogVisible" :header="editingId ? '编辑模型配置' : '添加模型'" width="560px">
      <t-form :data="form" layout="vertical" label-align="top">
        <t-form-item label="配置名称" required-mark>
          <t-input v-model="form.name" placeholder="例如：我的 DeepSeek / 本地 Ollama" />
        </t-form-item>

        <t-form-item label="模型提供商" required-mark>
          <t-select v-model="form.provider" :options="providerOptions"
            @change="(val: LlmProviderType) => onProviderChange(val)" />
        </t-form-item>

        <t-form-item label="API Base URL" :tips="form.provider === 'openai-compatible'
          ? '填写 API 根地址（到版本号为止），例如 https://open.bigmodel.cn/api/paas/v4 或 https://your-gateway/v1。请勿填成完整聊天接口 /chat/completions 或模型列表 /models，后端会自动处理。'
          : 'OpenAI / DeepSeek 可留空使用默认地址；Ollama 默认 http://localhost:11434。'
          ">
          <t-input v-model="form.baseUrl" :placeholder="form.provider === 'openai-compatible'
            ? '必填，到版本号为止，例如 https://open.bigmodel.cn/api/paas/v4'
            : '可留空使用默认地址'
            " />
        </t-form-item>

        <t-form-item :label="form.provider === 'ollama' ? 'API Key（可选）' : 'API Key'">
          <t-input v-model="form.apiKey" type="password" :placeholder="form.provider === 'ollama'
            ? '本地 Ollama 通常无需 Key'
            : '密钥仅加密存储，不会以明文返回前端'
            " />
        </t-form-item>

        <t-form-item label="模型 ID" tips="模型标识符，与 Base URL 是两回事。填写后只会添加这一个模型，不会自动拉取全部；留空则保存后可在卡片上点「获取模型」勾选添加。">
          <t-input v-model="form.modelId" placeholder="例如 deepseek-chat / gpt-4o-mini / qwen2.5:7b" />
        </t-form-item>

        <t-form-item label="显示名称">
          <t-input v-model="form.displayName" placeholder="留空则使用模型 ID" />
        </t-form-item>

        <t-form-item label="模型能力">
          <t-checkbox-group v-model="form.capabilities" :options="capabilityOptions" />
        </t-form-item>

        <t-alert v-if="testResult" :theme="testResult.ok ? 'success' : 'error'" :message="testResult.ok
          ? `连接成功，发现 ${testResult.models.length} 个模型`
          : `连接失败：${testResult.error || ''}`
          " class="test-result" />

      </t-form>

      <!-- 底部：左侧「测试连接」是额外操作，用 footer 插槽承载 -->
      <template #footer>
        <div class="dialog-footer">
          <t-button variant="outline" :loading="testing" @click="onTest">测试连接</t-button>
          <div class="footer-right">
            <t-button theme="default" variant="outline" @click="dialogVisible = false">取消</t-button>
            <t-button :loading="saving" theme="primary" @click="onSubmit">保存</t-button>
          </div>
        </div>
      </template>
    </t-dialog>

    <!-- 编辑 模型 对话框 -->
    <t-dialog v-model:visible="modelDialogVisible" header="编辑模型"
      :confirm-btn="{ content: '保存', theme: 'primary', loading: savingModel }" cancel-btn="取消" width="440px"
      @confirm="onSaveModel">
      <t-form layout="vertical" label-align="top">
        <t-form-item label="显示名称">
          <t-input v-model="modelForm.displayName" placeholder="留空使用模型 ID" />
        </t-form-item>
        <t-form-item label="模型能力" tips="可多选。能力以实测为准，不确定就点「验证」；视觉理解 ≠ 图片生成。">
          <t-checkbox-group v-model="modelForm.capabilities" :options="capabilityOptions" />
        </t-form-item>
        <t-form-item v-if="modelIsEmbedding" label="向量维度" tips="仅向量模型需要。推荐用「验证」按钮实测写入，不要靠模型名猜。">
          <t-input-number v-model="modelForm.embeddingDimensions" :min="1" :max="8192" :step="8" />
        </t-form-item>
        <t-form-item label="输入模态">
          <t-checkbox-group v-model="modelForm.inputModalities" :options="modalityOptions" />
        </t-form-item>
        <t-form-item label="输出模态">
          <t-checkbox-group v-model="modelForm.outputModalities" :options="modalityOptions" />
        </t-form-item>
        <t-form-item label="最大输入 Token">
          <t-input-number v-model="modelForm.maxInputTokens" :min="1" :step="1024" />
        </t-form-item>
        <t-alert v-if="editingModel && !editingModel.isVerified" theme="warning"
          message="该模型尚未通过实测验证，保存后建议点列表里的「验证」确认能力与维度。" />
      </t-form>
    </t-dialog>

    <!-- 手动添加单个模型 -->
    <t-dialog v-model:visible="addModelDialogVisible" :header="addModelConfigName ? `添加模型（${addModelConfigName}）` : '添加模型'
      " :confirm-btn="{ content: '添加', theme: 'primary', loading: addModelSaving }" cancel-btn="取消" width="480px"
      @confirm="onAddModelSubmit">
      <t-form layout="vertical" label-align="top">
        <t-form-item label="模型 ID" required-mark tips="只添加你填写的这一个模型，不会自动拉取全部。">
          <t-input v-model="addModelForm.modelId" placeholder="例如 deepseek-chat / gpt-4o-mini / qwen2.5:7b"
            @enter="onAddModelSubmit" />
        </t-form-item>
        <t-form-item label="显示名称">
          <t-input v-model="addModelForm.displayName" placeholder="留空则使用模型 ID" />
        </t-form-item>
        <t-form-item label="模型能力">
          <t-checkbox-group v-model="addModelForm.capabilities" :options="capabilityOptions" />
        </t-form-item>
      </t-form>
    </t-dialog>

    <!-- 获取模型：表格勾选后添加 -->
    <t-dialog v-model:visible="remoteDialogVisible" :header="remoteConfigName ? `获取模型（${remoteConfigName}）` : '获取模型'
      " :confirm-btn="{
        content: `添加选中${remoteSelected.length ? `（${remoteSelected.length}）` : ''}`,
        theme: 'primary',
        loading: remoteSaving,
      }" cancel-btn="取消" width="720px" @confirm="onAddSelectedModels">
      <div class="remote-toolbar">
        <t-input v-model="remoteKeyword" placeholder="搜索模型 ID" clearable class="remote-search">
          <template #prefix-icon><t-icon name="search" /></template>
        </t-input>
        <t-button variant="outline" :disabled="!filteredRemoteRows.length" @click="toggleSelectAll">全选 / 取消</t-button>
        <span class="remote-count">共 {{ filteredRemoteRows.length }} 个，已选
          {{ remoteSelected.length }} 个</span>
      </div>

      <t-table :data="filteredRemoteRows" :columns="remoteColumns" row-key="modelId" size="small" hover
        :loading="remoteLoading" :selected-row-keys="remoteSelected" select-on-row-click max-height="380px"
        empty="未获取到模型" @select-change="onRemoteSelectChange">
        <template #status="{ row }">
          <t-tag v-if="row.existing" size="small" theme="success" variant="light">已添加</t-tag>
          <span v-else class="muted">—</span>
        </template>
      </t-table>
    </t-dialog>
  </div>
</template>

<style scoped lang="less">
@import "../../styles/variables.less";

.page-subtitle {
  max-width: 560px;
}

.muted {
  color: @color-text-tertiary;
}

.config-list {
  display: flex;
  flex-direction: column;
  gap: @space-4;
}

.config-card {
  :deep(.t-card__body) {
    padding: @space-4;
  }

  .config-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: @space-3;
    flex-wrap: wrap;

    .config-title {
      display: flex;
      align-items: center;
      gap: @space-2;

      .config-name {
        font-size: @font-base;
        font-weight: 600;
        color: @color-text;
      }
    }

    .config-actions {
      display: flex;
      gap: @space-2;
      flex-wrap: wrap;
    }
  }

  .config-meta {
    display: flex;
    flex-wrap: wrap;
    gap: @space-4;
    margin: @space-3 0;
    font-size: @font-sm;

    .meta-label {
      color: @color-text-tertiary;
    }
  }

  .config-error {
    margin-bottom: @space-3;
  }

  .models-section {
    margin-top: @space-2;

    .models-title {
      font-size: @font-sm;
      font-weight: 600;
      color: @color-text-secondary;
      margin-bottom: @space-2;

      .models-hint {
        font-weight: 400;
        color: @color-text-tertiary;
        margin-left: @space-2;
      }
    }

    .cap-tag {
      margin-right: @space-1;
    }

    .models-empty {
      font-size: @font-sm;
      color: @color-text-tertiary;
      margin: @space-1 0 0;
    }

    .muted {
      color: @color-text-tertiary;
    }
  }
}

.test-result {
  margin-bottom: @space-3;
}

.dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: @space-4;

  .footer-right {
    display: flex;
    gap: @space-2;
  }
}

.remote-toolbar {
  display: flex;
  align-items: center;
  gap: @space-2;
  margin-bottom: @space-3;

  .remote-search {
    width: 240px;
  }

  .remote-count {
    margin-left: auto;
    font-size: @font-sm;
    color: @color-text-tertiary;
  }
}
</style>
