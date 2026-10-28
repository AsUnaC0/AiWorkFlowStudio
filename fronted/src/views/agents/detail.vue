<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
    getAgent,
    updateAgent,
    getAgentResources,
    type Agent,
    type AgentResourceWorkflow,
    type AgentResourceKnowledgeBase,
} from "@/api/agent";
import { AGENT_TEMPLATES } from "@/types/agent";
import { getLlmModels } from "@/api/provider";
import { type LlmModel, PROVIDER_LABELS } from "@/types/provider";
import { MessagePlugin } from "tdesign-vue-next";
import PersonaPanel from "./components/PersonaPanel.vue";
import MemoryPanel from "@/components/memory/MemoryPanel.vue";

const route = useRoute();
const router = useRouter();

const agentId = computed(() => route.params.id as string);
const loading = ref(false);
const saving = ref(false);

const agent = ref<Agent | null>(null);
const form = ref({
    name: "",
    description: "",
    llmModelId: "",
    systemPrompt: "",
    workflowIds: [] as string[],
    knowledgeBaseIds: [] as string[],
    maxToolIterations: 10,
    temperature: 0.7,
});

// 用户在「模型管理」中添加的对话模型（供下拉选择）
const userModels = ref<LlmModel[]>([]);
const loadModels = async () => {
    try {
        userModels.value = await getLlmModels("CHAT");
    } catch {
        userModels.value = [];
    }
};
const modelOptions = computed(() => [
    { value: "", label: "Ollama 本地（默认 qwen2.5:7b）" },
    ...userModels.value.map((m) => ({
        value: m.id,
        label: `${m.displayName || m.modelId}（${PROVIDER_LABELS[m.provider]}）`,
    })),
]);

const resources = ref<{
    workflows: AgentResourceWorkflow[];
    knowledgeBases: AgentResourceKnowledgeBase[];
}>({ workflows: [], knowledgeBases: [] });

const loadAgent = async () => {
    if (!agentId.value) return;
    loading.value = true;
    try {
        const a = await getAgent(agentId.value);
        agent.value = a;
        form.value = {
            name: a.name,
            description: a.description ?? "",
            llmModelId: a.llmModelId ?? "",
            systemPrompt: a.systemPrompt ?? "",
            workflowIds: [...a.workflowIds],
            knowledgeBaseIds: [...a.knowledgeBaseIds],
            maxToolIterations: a.maxToolIterations,
            temperature: a.temperature,
        };
    } catch (err: any) {
        MessagePlugin.error("加载 Agent 失败");
        router.push("/agents");
    } finally {
        loading.value = false;
    }
};

const loadResources = async () => {
    try {
        resources.value = await getAgentResources();
    } catch {
        // ignore
    }
};

onMounted(() => {
    loadAgent();
    loadResources();
    loadModels();
});

watch(() => route.params.id, loadAgent);

const isSystemAgent = computed(() => agent.value?.isSystem ?? false);
const template = computed(() => AGENT_TEMPLATES.find((t) => t.type === agent.value?.type));

/**
 * 平台助理（isSystem && isDefault）才有人格与记忆两个 Tab。
 *
 * 判据与后端 PlatformAssistantService.isPlatformAssistant 保持一致 ——
 * 用「系统默认」这个事实，而不是名字（名字可以被人格改掉）。
 */
const isPlatformAssistantAgent = computed(
    () => !!agent.value?.isSystem && !!agent.value?.isDefault,
);

const TAB_VALUES = ["config", "persona", "memory"] as const;
type AgentTab = (typeof TAB_VALUES)[number];

/**
 * 当前 Tab。
 *
 * 初值从 ?tab= 读 —— 聊天页的「人格 / 记忆」按钮就是带 query 跳过来的，
 * 这样点一次就能直接落到对应面板，而不是先到配置页再点一下。
 */
const activeTab = ref<AgentTab>(
    TAB_VALUES.includes(route.query.tab as AgentTab)
        ? (route.query.tab as AgentTab)
        : "config",
);

// Tab 写回 URL：刷新页面、复制链接都能保持当前位置
watch(activeTab, (tab) => {
    const query = { ...route.query };
    if (tab === "config") delete query.tab;
    else query.tab = tab;
    void router.replace({ query });
});

// 切到普通 Agent 时，人格 / 记忆 Tab 不存在，必须退回配置页，否则会渲染空白
watch(isPlatformAssistantAgent, (isAssistant) => {
    if (!isAssistant && activeTab.value !== "config") activeTab.value = "config";
});

const toggleWorkflow = (id: string) => {
    const i = form.value.workflowIds.indexOf(id);
    if (i > -1) form.value.workflowIds.splice(i, 1);
    else form.value.workflowIds.push(id);
};

const toggleKB = (id: string) => {
    const i = form.value.knowledgeBaseIds.indexOf(id);
    if (i > -1) form.value.knowledgeBaseIds.splice(i, 1);
    else form.value.knowledgeBaseIds.push(id);
};

const hasChanges = computed(() => {
    if (!agent.value) return false;
    return (
        form.value.name !== agent.value.name ||
        form.value.description !== (agent.value.description ?? "") ||
        form.value.llmModelId !== (agent.value.llmModelId ?? "") ||
        form.value.systemPrompt !== (agent.value.systemPrompt ?? "") ||
        JSON.stringify(form.value.workflowIds) !== JSON.stringify(agent.value.workflowIds) ||
        JSON.stringify(form.value.knowledgeBaseIds) !== JSON.stringify(agent.value.knowledgeBaseIds) ||
        form.value.maxToolIterations !== agent.value.maxToolIterations ||
        form.value.temperature !== agent.value.temperature
    );
});

const handleSave = async () => {
    if (!agent.value) return;
    if (!isSystemAgent.value && !form.value.name.trim()) {
        MessagePlugin.warning("Agent 名称不能为空");
        return;
    }

    saving.value = true;
    try {
        if (isSystemAgent.value) {
            // 系统预设 Agent：后端只放开模型配置，其余字段由系统维护。
            // 这里必须「只发模型字段」——多带一个字段整个请求都会被拒（400）。
            await updateAgent(agent.value.id, {
                llmModelId: form.value.llmModelId,
                temperature: form.value.temperature,
            });
        } else {
            await updateAgent(agent.value.id, {
                name: form.value.name.trim(),
                description: form.value.description || undefined,
                llmModelId: form.value.llmModelId,
                systemPrompt: form.value.systemPrompt || undefined,
                workflowIds: form.value.workflowIds,
                knowledgeBaseIds: form.value.knowledgeBaseIds,
                maxToolIterations: form.value.maxToolIterations,
                temperature: form.value.temperature,
            });
        }
        MessagePlugin.success("保存成功");
        await loadAgent();
    } catch (err) {
        MessagePlugin.error("保存失败");
    } finally {
        saving.value = false;
    }
};

const goChat = () => {
    if (agent.value) router.push(`/chat?agent=${agent.value.id}`);
};
</script>

<template>
    <div class="page-container" v-if="agent">
        <!-- 顶部栏 -->
        <header class="detail-header">
            <div class="header-left">
                <t-button variant="text" size="small" @click="router.push('/agents')">
                    <template #icon><t-icon name="chevron-left" /></template>
                    Agent 列表
                </t-button>
                <div class="agent-title-row">
                    <div class="agent-avatar" :class="agent.type.toLowerCase()">
                        <t-icon :name="template?.icon ?? 'chat'" />
                    </div>
                    <div class="agent-info">
                        <h1 class="agent-name">{{ agent.name }}</h1>
                        <div class="agent-meta">
                            <t-tag :theme="agent.isSystem ? 'warning' : agent.isDefault ? 'primary' : 'default'"
                                variant="light" size="small">
                                {{ agent.isSystem ? "系统" : agent.isDefault ? "默认" : "自定义" }}
                            </t-tag>
                            <span class="agent-type">{{ agent.type.toLowerCase() }}</span>
                        </div>
                    </div>
                </div>
            </div>
            <div class="header-actions">
                <t-button variant="outline" @click="goChat">
                    <template #icon><t-icon name="chat" /></template>
                    对话
                </t-button>
                <t-button theme="primary" v-if="activeTab === 'config'" :disabled="!hasChanges" :loading="saving"
                    @click="handleSave">
                    <template #icon><t-icon name="save" /></template>
                    保存配置
                </t-button>
            </div>
        </header>

        <t-tabs v-model="activeTab" class="agent-tabs">
            <t-tab-panel value="config" label="配置">
                <div class="detail-body">
            <!-- 左侧：基本信息 -->
            <div class="config-main">
                <!-- 基本信息 -->
                <section class="config-section">
                    <h2 class="section-title">基本信息</h2>
                    <div class="form-grid">
                        <div class="form-item">
                            <label>Agent 名称</label>
                            <t-input v-model="form.name" placeholder="为 Agent 起一个名字" :disabled="isSystemAgent" />
                        </div>
                        <div class="form-item full">
                            <label>描述</label>
                            <t-textarea v-model="form.description" placeholder="简单描述这个 Agent 的用途..."
                                :autosize="{ minRows: 2 }" :disabled="isSystemAgent" />
                        </div>
                    </div>
                </section>

                <!-- 模型配置 -->
                <section class="config-section">
                    <h2 class="section-title">模型配置</h2>
                    <div class="form-grid">
                        <div class="form-item">
                            <label>LLM 模型</label>
                            <t-select v-model="form.llmModelId" placeholder="选择模型">
                                <t-option v-for="opt in modelOptions" :key="opt.value" :value="opt.value"
                                    :label="opt.label" />
                            </t-select>
                            <p class="form-hint">
                                选择你在「模型管理」中添加的模型；选「Ollama 本地」则使用本地默认模型。
                            </p>
                        </div>
                        <div class="form-item">
                            <label for="temp">温度 ({{ form.temperature }})</label>
                            <input id="temp" v-model.number="form.temperature" type="range" min="0" max="2" step="0.1"
                                class="form-range" />
                            <div class="range-labels">
                                <span>精确 0</span>
                                <span>创意 2</span>
                            </div>
                        </div>
                    </div>
                </section>

                <!-- 系统提示词 -->
                <section class="config-section">
                    <h2 class="section-title">
                        系统提示词 (System Prompt)
                        <span class="section-hint">告诉 Agent 它是谁、应该怎么回答</span>
                    </h2>
                    <t-textarea v-model="form.systemPrompt" placeholder="你是一个..."
                        :autosize="{ minRows: 6, maxRows: 20 }" :disabled="isSystemAgent" />
                </section>

                <!-- 知识库 -->
                <section class="config-section">
                    <h2 class="section-title">
                        知识库
                        <span class="section-hint">Agent 将自动检索绑定的知识库来回答问题</span>
                    </h2>
                    <div v-if="resources.knowledgeBases.length === 0" class="empty-hint">
                        暂无可用知识库，请先在知识库页面创建
                    </div>
                    <div v-else class="resource-grid">
                        <div v-for="kb in resources.knowledgeBases" :key="kb.id" class="resource-card" role="button"
                            tabindex="0" :class="{ active: form.knowledgeBaseIds.includes(kb.id) }"
                            @click="toggleKB(kb.id)">
                            <div class="resource-icon">
                                <t-icon name="library" />
                            </div>
                            <div class="resource-info">
                                <span class="resource-name">{{ kb.name }}</span>
                                <span class="resource-meta">{{ kb.documentCount }} 文档 · {{ kb.chunkCount }} 分块</span>
                            </div>
                            <t-icon v-if="form.knowledgeBaseIds.includes(kb.id)" name="check" class="resource-check" />
                        </div>
                    </div>
                </section>

                <!-- 工作流 -->
                <section class="config-section">
                    <h2 class="section-title">
                        工作流
                        <span class="section-hint">Agent 可调用的已发布工作流</span>
                    </h2>
                    <div v-if="resources.workflows.length === 0" class="empty-hint">
                        暂无已发布工作流，请先在工作空间创建并发布
                    </div>
                    <div v-else class="resource-grid">
                        <div v-for="wf in resources.workflows" :key="wf.id" class="resource-card" role="button"
                            tabindex="0" :class="{ active: form.workflowIds.includes(wf.id) }"
                            @click="toggleWorkflow(wf.id)">
                            <div class="resource-icon">
                                <t-icon name="flow" />
                            </div>
                            <div class="resource-info">
                                <span class="resource-name">
                                    {{ wf.name }}
                                    <span class="resource-version">v{{ wf.publishedVersion?.version ?? "-" }}</span>
                                </span>
                                <span class="resource-meta">{{ wf.description ?? "已发布工作流" }}</span>
                            </div>
                            <t-icon v-if="form.workflowIds.includes(wf.id)" name="check" class="resource-check" />
                        </div>
                    </div>
                </section>
            </div>

            <!-- 右侧：运行参数 -->
            <aside class="config-side">
                <section class="config-section compact">
                    <h2 class="section-title">运行参数</h2>
                    <div class="form-item">
                        <label for="iters">最大工具调用轮数 ({{ form.maxToolIterations }})</label>
                        <input id="iters" v-model.number="form.maxToolIterations" type="range" min="1" max="30" step="1"
                            class="form-range" :disabled="isSystemAgent" />
                        <div class="range-labels">
                            <span>1</span>
                            <span>30</span>
                        </div>
                        <p class="form-hint">ReAct 循环上限，防止无限工具调用</p>
                    </div>
                </section>

                <section class="config-section compact info">
                    <h2 class="section-title">基本信息</h2>
                    <div class="info-grid">
                        <div class="info-row">
                            <span class="info-label">类型</span>
                            <span class="info-value">{{ agent.type.toLowerCase() }}</span>
                        </div>
                        <div class="info-row">
                            <span class="info-label">状态</span>
                            <span class="info-value">{{ agent.status.toLowerCase() }}</span>
                        </div>
                        <div class="info-row">
                            <span class="info-label">创建时间</span>
                            <span class="info-value">{{ new Date(agent.createdAt).toLocaleString() }}</span>
                        </div>
                        <div class="info-row">
                            <span class="info-label">更新时间</span>
                            <span class="info-value">{{ new Date(agent.updatedAt).toLocaleString() }}</span>
                        </div>
                    </div>
                </section>

                <section v-if="isSystemAgent" class="config-section compact warning">
                    <t-icon name="info-circle" class="warning-icon" />
                    <p>
                        这是系统预设 Agent：名称、描述、系统提示词与绑定资源由系统维护，不可修改；<strong>模型配置（模型、温度）可以调整</strong>。
                        <template v-if="isPlatformAssistantAgent">
                            <br />
                            想改它的名字、语气、音色与主动行为？那属于<strong>人格</strong>配置，在上面「人格」标签页里维护；
                            它记得什么，看「记忆」标签页。
                            <t-button size="small" variant="outline" class="persona-entry" @click="activeTab = 'persona'">
                                去配置人格
                            </t-button>
                        </template>
                    </p>
                </section>
            </aside>
                </div>
            </t-tab-panel>

            <!-- 人格：平台助理的「表达层」，只改语气/音色/主动行为 -->
            <t-tab-panel v-if="isPlatformAssistantAgent" value="persona" label="人格">
                <PersonaPanel :agent-id="agent.id" />
            </t-tab-panel>

            <!-- 记忆：助理记得什么，看得见 -->
            <t-tab-panel v-if="isPlatformAssistantAgent" value="memory" label="记忆">
                <MemoryPanel embedded />
            </t-tab-panel>
        </t-tabs>
    </div>

    <div v-else-if="loading" class="loading-state">
        <t-icon name="loading" spin />
        <span>加载中...</span>
    </div>
</template>

<style scoped lang="less">
@import "../../styles/variables.less";

/* ---------- 详情页头部 ---------- */
.detail-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: @space-5;
    border-bottom: 1px solid @color-border;
    margin-bottom: @space-6;

    .header-left {
        display: flex;
        flex-direction: column;
        gap: @space-3;
    }

    .agent-title-row {
        display: flex;
        align-items: center;
        gap: @space-4;
    }

    .agent-avatar {
        width: 52px;
        height: 52px;
        border-radius: @radius-xl;
        background: @color-bg-hover;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 26px;

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
    }

    .agent-name {
        font-size: @font-xl;
        font-weight: 700;
        margin: 0;
    }

    .agent-meta {
        display: flex;
        align-items: center;
        gap: @space-2;

        .agent-type {
            font-size: @font-xs;
            color: @color-text-tertiary;
        }
    }

    .header-actions {
        display: flex;
        gap: @space-3;
    }
}

/* ---------- 双栏布局 ---------- */
.detail-body {
    display: grid;
    grid-template-columns: 1fr 320px;
    gap: @space-8;
}

/* ---------- 配置区块（卡片）---------- */
.config-section {
    background: @color-bg-surface;
    border: 1px solid @color-border;
    border-radius: @radius-lg;
    padding: @space-5;
    margin-bottom: @space-5;

    &.compact {
        padding: @space-4;
        margin-bottom: @space-4;
    }

    &.info {
        .info-value {
            font-size: @font-xs;
        }
    }

    &.warning {
        background: rgba(249, 115, 22, 0.04);
        border-color: rgba(249, 115, 22, 0.2);
        display: flex;
        gap: @space-2;
        align-items: flex-start;

        p {
            font-size: @font-sm;
            color: #f97316;
            margin: 0;
            line-height: 1.5;
        }

        .warning-icon {
            color: #f97316;
            flex-shrink: 0;
            margin-top: 2px;
        }

        .persona-entry {
            margin-top: @space-2;
        }
    }
}

/* section-title 在全局有定义，这里只补充特有子元素 */
.section-title .section-hint {
    font-size: @font-xs;
    font-weight: 400;
    color: @color-text-tertiary;
}

/* ---------- 表单布局 ---------- */
.form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: @space-4;

    .form-item.full {
        grid-column: 1 / -1;
    }
}

.form-item {
    display: flex;
    flex-direction: column;
    gap: @space-2;

    label {
        font-size: @font-xs;
        font-weight: 500;
        color: @color-text-secondary;
    }

    .form-hint {
        font-size: @font-xs;
        color: @color-text-tertiary;
        margin: 0;
    }
}

/* ---------- 系统提示词等宽字体 ---------- */
:deep(.t-textarea__inner) {
    /* 默认等宽字体应用到所有 textarea（系统提示词区块） */
}

.config-section:nth-of-type(3) {
    :deep(.t-textarea__inner) {
        font-family: "Menlo", "Consolas", monospace;
        font-size: 13px;
        line-height: 1.6;
    }
}

.form-range {
    width: 100%;
    accent-color: @primary;
}

.range-labels {
    display: flex;
    justify-content: space-between;
    font-size: @font-xs;
    color: @color-text-tertiary;
}

/* ---------- 资源选择卡片 ---------- */
.resource-grid {
    display: flex;
    flex-direction: column;
    gap: @space-2;
}

.resource-card {
    display: flex;
    align-items: center;
    gap: @space-3;
    padding: @space-3;
    border: 1px solid @color-border;
    border-radius: @radius-md;
    background: transparent;
    cursor: pointer;
    text-align: left;
    transition: all @duration-fast;

    &:hover {
        background: @color-bg-hover;
    }

    &.active {
        border-color: @primary;
        background: @primary-light;
    }

    .resource-icon {
        width: 36px;
        height: 36px;
        border-radius: @radius-md;
        background: @color-bg-hover;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 18px;
        flex-shrink: 0;
        color: @color-text-secondary;
    }

    .resource-info {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;

        .resource-name {
            font-size: @font-sm;
            font-weight: 600;
            color: @color-text;
            display: flex;
            align-items: center;
            gap: @space-2;

            .resource-version {
                font-size: @font-xs;
                font-weight: 400;
                color: @color-text-tertiary;
                padding: 1px 6px;
                background: @color-bg-hover;
                border-radius: @radius-pill;
            }
        }

        .resource-meta {
            font-size: @font-xs;
            color: @color-text-tertiary;
        }
    }

    .resource-check {
        color: @primary;
        font-size: 18px;
        flex-shrink: 0;
    }
}

.empty-hint {
    font-size: @font-sm;
    color: @color-text-tertiary;
    padding: @space-4;
    background: @color-bg-hover;
    border-radius: @radius-md;
    text-align: center;
}

/* ---------- 基本信息网格 ---------- */
.info-grid {
    display: flex;
    flex-direction: column;
    gap: @space-3;
}

.info-row {
    display: flex;
    justify-content: space-between;
    align-items: center;

    .info-label {
        font-size: @font-xs;
        color: @color-text-tertiary;
    }

    .info-value {
        font-size: @font-sm;
        color: @color-text;
        font-weight: 500;
    }
}

/* ---------- Tab 布局 ----------
 * 类名已核对 tdesign-vue-next/es/tabs/style/index.css：
 * 根节点 .t-tabs、导航 .t-tabs__nav、内容 .t-tabs__content。
 * TDesign 默认导航与内容贴得比较紧，这里补一点间距。
 */
.agent-tabs {
    :deep(.t-tabs__nav) {
        margin-bottom: @space-5;
    }
}

.loading-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: @space-3;
    padding: @space-16;
    color: @color-text-tertiary;
}
</style>
