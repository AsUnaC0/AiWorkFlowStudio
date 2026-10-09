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
import { MessagePlugin } from "tdesign-vue-next";

const route = useRoute();
const router = useRouter();

const agentId = computed(() => route.params.id as string);
const loading = ref(false);
const saving = ref(false);

const agent = ref<Agent | null>(null);
const form = ref({
    name: "",
    description: "",
    model: "",
    systemPrompt: "",
    workflowIds: [] as string[],
    knowledgeBaseIds: [] as string[],
    maxToolIterations: 10,
    temperature: 0.7,
});

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
            model: a.model,
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
});

watch(() => route.params.id, loadAgent);

const isSystemAgent = computed(() => agent.value?.isSystem ?? false);
const template = computed(() => AGENT_TEMPLATES.find((t) => t.type === agent.value?.type));

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
        form.value.model !== agent.value.model ||
        form.value.systemPrompt !== (agent.value.systemPrompt ?? "") ||
        JSON.stringify(form.value.workflowIds) !== JSON.stringify(agent.value.workflowIds) ||
        JSON.stringify(form.value.knowledgeBaseIds) !== JSON.stringify(agent.value.knowledgeBaseIds) ||
        form.value.maxToolIterations !== agent.value.maxToolIterations ||
        form.value.temperature !== agent.value.temperature
    );
});

const handleSave = async () => {
    if (!agent.value) return;
    if (!form.value.name.trim()) {
        MessagePlugin.warning("Agent 名称不能为空");
        return;
    }

    saving.value = true;
    try {
        await updateAgent(agent.value.id, {
            name: form.value.name.trim(),
            description: form.value.description || undefined,
            model: form.value.model,
            systemPrompt: form.value.systemPrompt || undefined,
            workflowIds: form.value.workflowIds,
            knowledgeBaseIds: form.value.knowledgeBaseIds,
            maxToolIterations: form.value.maxToolIterations,
            temperature: form.value.temperature,
        });
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
    <div class="agent-detail" v-if="agent">
        <!-- 顶部栏 -->
        <header class="detail-header">
            <div class="header-left">
                <button class="back-btn" @click="router.push('/agents')">
                    <t-icon name="chevron-left" />
                    <span>Agent 列表</span>
                </button>
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
                <button class="action-btn secondary" @click="goChat">
                    <t-icon name="chat" />
                    对话
                </button>
                <button class="action-btn primary" :disabled="!hasChanges" :loading="saving" @click="handleSave">
                    <t-icon name="save" />
                    保存配置
                </button>
            </div>
        </header>

        <div class="detail-body">
            <!-- 左侧：基本信息 -->
            <div class="config-main">
                <!-- 基本信息 -->
                <section class="config-section">
                    <h2 class="section-title">基本信息</h2>
                    <div class="form-grid">
                        <div class="form-item">
                            <label>Agent 名称</label>
                            <input v-model="form.name" type="text" class="form-input" placeholder="为 Agent 起一个名字"
                                :disabled="isSystemAgent" />
                        </div>
                        <div class="form-item full">
                            <label>描述</label>
                            <textarea v-model="form.description" class="form-textarea" placeholder="简单描述这个 Agent 的用途..."
                                rows="2" :disabled="isSystemAgent" />
                        </div>
                    </div>
                </section>

                <!-- 模型配置 -->
                <section class="config-section">
                    <h2 class="section-title">模型配置</h2>
                    <div class="form-grid">
                        <div class="form-item">
                            <label>LLM 模型</label>
                            <input v-model="form.model" type="text" class="form-input" placeholder="qwen2.5:7b" />
                            <p class="form-hint">Ollama 本地模型名，如 qwen2.5:7b / deepseek-r1:7b</p>
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
                    <textarea v-model="form.systemPrompt" class="form-textarea prompt" placeholder="你是一个..." rows="6"
                        :disabled="isSystemAgent" />
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
                        <button v-for="kb in resources.knowledgeBases" :key="kb.id" class="resource-card"
                            :class="{ active: form.knowledgeBaseIds.includes(kb.id) }" @click="toggleKB(kb.id)">
                            <div class="resource-icon">
                                <t-icon name="library" />
                            </div>
                            <div class="resource-info">
                                <span class="resource-name">{{ kb.name }}</span>
                                <span class="resource-meta">{{ kb.documentCount }} 文档 · {{ kb.chunkCount }} 分块</span>
                            </div>
                            <t-icon v-if="form.knowledgeBaseIds.includes(kb.id)" name="check" class="resource-check" />
                        </button>
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
                        <button v-for="wf in resources.workflows" :key="wf.id" class="resource-card"
                            :class="{ active: form.workflowIds.includes(wf.id) }" @click="toggleWorkflow(wf.id)">
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
                        </button>
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
                            class="form-range" />
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
                    <p>这是一个系统预设 Agent，部分配置不可修改。</p>
                </section>
            </aside>
        </div>
    </div>

    <div v-else-if="loading" class="loading-state">
        <t-icon name="loading" spin />
        <span>加载中...</span>
    </div>
</template>

<style scoped lang="less">
@import "../../styles/variables.less";

.agent-detail {
    padding: @space-6 @space-10;
    max-width: 1200px;
    margin: 0 auto;
}

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

    .back-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 4px 10px;
        border: none;
        background: transparent;
        color: @color-text-secondary;
        font-size: @font-sm;
        cursor: pointer;
        border-radius: @radius-md;
        width: fit-content;

        &:hover {
            background: @color-bg-hover;
            color: @primary;
        }
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
        font-size: 22px;
        font-weight: 700;
        margin: 0;
    }

    .agent-meta {
        display: flex;
        align-items: center;
        gap: @space-2;

        .agent-type {
            font-size: 12px;
            color: @color-text-tertiary;
        }
    }

    .header-actions {
        display: flex;
        gap: @space-3;
    }
}

.action-btn {
    display: inline-flex;
    align-items: center;
    gap: @space-1;
    padding: @space-2 @space-4;
    border: 1px solid @color-border;
    border-radius: @radius-md;
    font-size: @font-sm;
    cursor: pointer;
    transition: all @duration-fast;

    &.secondary {
        background: transparent;
        color: @color-text-secondary;

        &:hover {
            background: @color-bg-hover;
            color: @color-text;
        }
    }

    &.primary {
        background: @primary;
        color: #fff;
        border-color: @primary;

        &:hover:not(:disabled) {
            background: @primary-hover;
        }

        &:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
    }
}

.detail-body {
    display: grid;
    grid-template-columns: 1fr 320px;
    gap: @space-8;
}

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
            font-size: 12px;
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
    }
}

.section-title {
    font-size: @font-sm;
    font-weight: 600;
    color: @color-text;
    margin: 0 0 @space-4;
    display: flex;
    align-items: center;
    gap: @space-2;

    .section-hint {
        font-size: 12px;
        font-weight: 400;
        color: @color-text-tertiary;
    }
}

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
        font-size: 12px;
        font-weight: 500;
        color: @color-text-secondary;
    }

    .form-hint {
        font-size: 11px;
        color: @color-text-tertiary;
        margin: 0;
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

    &:disabled {
        background: @color-bg-hover;
        cursor: not-allowed;
        color: @color-text-tertiary;
    }
}

.form-textarea {
    resize: vertical;
    min-height: 80px;

    &.prompt {
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
    font-size: 11px;
    color: @color-text-tertiary;
}

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
                font-size: 11px;
                font-weight: 400;
                color: @color-text-tertiary;
                padding: 1px 6px;
                background: @color-bg-hover;
                border-radius: @radius-pill;
            }
        }

        .resource-meta {
            font-size: 12px;
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
        font-size: 12px;
        color: @color-text-tertiary;
    }

    .info-value {
        font-size: @font-sm;
        color: @color-text;
        font-weight: 500;
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
