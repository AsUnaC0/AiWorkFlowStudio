<script setup lang="ts">
import { onMounted, ref } from "vue";
import {
  createSkill,
  getSkills,
  updateSkill,
  removeSkill,
} from "@/api/skill";
import { MessagePlugin } from "tdesign-vue-next";
import type { Skill, InputParam } from "@/types/skill";

// ========== Skill 列表 ==========
const skills = ref<Skill[]>([]);
const skillsLoading = ref(false);
const skillsError = ref("");

const fetchSkills = async () => {
  skillsLoading.value = true;
  skillsError.value = "";
  try {
    skills.value = await getSkills();
  } catch {
    skillsError.value = "Skills 加载失败，请稍后重试";
  } finally {
    skillsLoading.value = false;
  }
};

// ========== 创建 / 编辑 Skill ==========
const createDialogVisible = ref(false);
const editingSkill = ref<Skill | null>(null);
const formSaving = ref(false);
const formError = ref("");

const formData = ref({
  name: "",
  description: "",
  type: "PROMPT" as "PROMPT" | "WORKFLOW" | "TOOL",
  instructions: "",
  outputFormat: "Markdown",
  params: [] as InputParam[],
});

const resetForm = () => {
  formData.value = {
    name: "",
    description: "",
    type: "PROMPT",
    instructions: "",
    outputFormat: "Markdown",
    params: [],
  };
  formError.value = "";
};

const openCreateDialog = () => {
  editingSkill.value = null;
  resetForm();
  createDialogVisible.value = true;
};

const openEditDialog = (skill: Skill) => {
  editingSkill.value = skill;
  formData.value = {
    name: skill.name,
    description: skill.description || "",
    type: skill.type,
    instructions: skill.instructions || "",
    outputFormat: skill.outputFormat || "Markdown",
    params: parseInputSchema(skill.inputSchema),
  };
  formError.value = "";
  createDialogVisible.value = true;
};

// 输入参数管理
const addParam = () => {
  formData.value.params.push({ name: "", type: "string", description: "", required: false });
};

const removeParam = (index: number) => {
  formData.value.params.splice(index, 1);
};

// 将 params 数组转为 JSON Schema
const buildInputSchema = (params: InputParam[]) => {
  if (params.length === 0) return undefined;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of params) {
    if (!p.name.trim()) continue;
    properties[p.name] = {
      type: p.type,
      description: p.description || undefined,
    };
    if (p.required) required.push(p.name);
  }
  return {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
  };
};

// 从 JSON Schema 解析回 params 数组
const parseInputSchema = (schema: unknown): InputParam[] => {
  if (!schema || typeof schema !== "object") return [];
  const s = schema as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
  if (!s.properties) return [];
  const requiredList = s.required || [];
  return Object.entries(s.properties).map(([name, prop]) => ({
    name,
    type: prop.type || "string",
    description: prop.description || "",
    required: requiredList.includes(name),
  }));
};

const submitForm = async () => {
  const name = formData.value.name.trim();
  if (!name) {
    formError.value = "请输入 Skill 名称";
    return;
  }
  if (formData.value.type === "PROMPT" && !formData.value.instructions.trim()) {
    formError.value = "Prompt 类型 Skill 需要填写 Instructions";
    return;
  }

  formSaving.value = true;
  formError.value = "";
  try {
    const payload = {
      name,
      description: formData.value.description.trim() || undefined,
      type: formData.value.type,
      instructions: formData.value.instructions.trim() || undefined,
      outputFormat: formData.value.outputFormat,
      inputSchema: buildInputSchema(formData.value.params),
    };

    if (editingSkill.value) {
      await updateSkill(editingSkill.value.id, payload);
      MessagePlugin.success("Skill 更新成功");
    } else {
      await createSkill(payload);
      MessagePlugin.success("Skill 创建成功");
    }
    createDialogVisible.value = false;
    fetchSkills();
  } catch {
    formError.value = editingSkill.value ? "更新失败，请稍后重试" : "创建失败，请稍后重试";
  } finally {
    formSaving.value = false;
  }
};

// ========== 删除 Skill ==========
const deleteTarget = ref<Skill | null>(null);
const deleteDialogVisible = ref(false);
const deleting = ref(false);

const openDeleteDialog = (skill: Skill) => {
  deleteTarget.value = skill;
  deleteDialogVisible.value = true;
};

const submitDelete = async () => {
  if (!deleteTarget.value) return;
  deleting.value = true;
  try {
    await removeSkill(deleteTarget.value.id);
    deleteDialogVisible.value = false;
    MessagePlugin.success("Skill 已删除");
    fetchSkills();
  } catch {
    MessagePlugin.error("删除失败，请稍后重试");
  } finally {
    deleting.value = false;
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

const getTypeLabel = (type: string) => {
  const map: Record<string, { label: string; cls: string }> = {
    PROMPT: { label: "Prompt", cls: "prompt" },
    WORKFLOW: { label: "Workflow", cls: "workflow" },
    TOOL: { label: "Tool", cls: "tool" },
  };
  return map[type] || { label: type, cls: "prompt" };
};

const getParamCount = (skill: Skill): number => {
  const schema = skill.inputSchema as { properties?: Record<string, unknown> } | null;
  if (!schema?.properties) return 0;
  return Object.keys(schema.properties).length;
};

onMounted(() => {
  fetchSkills();
});
</script>

<template>
  <div class="page-container">
    <!-- 页面头部 -->
    <div class="page-header">
      <div class="page-header-info">
        <h1 class="page-title">Skills</h1>
        <p class="page-subtitle">
          Define reusable AI capabilities. Skills tell your Agent or LLM node how to complete specific tasks.
        </p>
      </div>
      <div class="page-header-actions">
        <t-button theme="primary" @click="openCreateDialog">
          <template #icon><t-icon name="add" /></template>
          New Skill
        </t-button>
      </div>
    </div>

    <!-- 内容 -->
    <t-loading :loading="skillsLoading" text="Loading..." :delay="200">
      <t-alert v-if="skillsError" theme="error" :message="skillsError" style="margin-top: var(--space-4)" />

      <!-- Skill 列表 -->
      <template v-else-if="skills.length > 0">
        <div class="skill-list">
          <div
            v-for="skill in skills"
            :key="skill.id"
            class="skill-row"
          >
            <!-- 图标 -->
            <div class="skill-icon" :class="getTypeLabel(skill.type).cls">
              <t-icon :name="skill.type === 'WORKFLOW' ? 'flow' : skill.type === 'TOOL' ? 'plugin' : 'code'" />
            </div>

            <!-- 主信息 -->
            <div class="skill-main" @click="openEditDialog(skill)">
              <div class="skill-name">{{ skill.name }}</div>
              <div class="skill-desc">{{ skill.description || 'No description' }}</div>
            </div>

            <!-- 类型 + 参数 -->
            <div class="skill-meta">
              <span class="type-badge" :class="getTypeLabel(skill.type).cls">
                {{ getTypeLabel(skill.type).label }}
              </span>
              <span class="param-count">{{ getParamCount(skill) }} params</span>
            </div>

            <!-- 时间 -->
            <div class="skill-updated">{{ formatRelativeTime(skill.updatedAt) }}</div>

            <!-- 操作 -->
            <div class="skill-row-actions">
              <t-dropdown @click.stop>
                <button class="row-more-btn" @click.stop>
                  <t-icon name="more" />
                </button>
                <template #dropdown>
                  <t-dropdown-menu>
                    <t-dropdown-item @click.stop="openEditDialog(skill)">
                      <template #prefix><t-icon name="edit-1" /></template>
                      Edit
                    </t-dropdown-item>
                    <t-dropdown-item @click.stop="openDeleteDialog(skill)">
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
      <div v-else-if="!skillsLoading && !skillsError" class="empty-state">
        <div class="empty-icon"><t-icon name="code" /></div>
        <h3 class="empty-title">No skills yet</h3>
        <p class="empty-desc">
          Create your first skill to give your Agent reusable capabilities like SEO writing, code review, or data analysis.
        </p>
        <t-button theme="primary" @click="openCreateDialog">
          <template #icon><t-icon name="add" /></template>
          Create Skill
        </t-button>
      </div>
    </t-loading>

    <!-- 创建 / 编辑 Skill 对话框 -->
    <t-dialog
      v-model:visible="createDialogVisible"
      :header="editingSkill ? 'Edit Skill' : 'Create Skill'"
      :footer="false"
      width="600px"
    >
      <t-form layout="vertical" @submit="submitForm">
        <t-form-item label="Name">
          <t-input v-model="formData.name" placeholder="SEO Article Generation" maxlength="200" />
        </t-form-item>
        <t-form-item label="Description (optional)">
          <t-textarea
            v-model="formData.description"
            placeholder="Generate SEO-optimized articles from keywords"
            :maxlength="1000"
            :autosize="{ minRows: 2, maxRows: 4 }"
          />
        </t-form-item>
        <t-form-item label="Type">
          <t-select v-model="formData.type">
            <t-option value="PROMPT" label="Prompt Skill" />
            <t-option value="WORKFLOW" label="Workflow Skill" />
            <t-option value="TOOL" label="Tool Skill" />
          </t-select>
        </t-form-item>
        <t-form-item v-if="formData.type === 'PROMPT'" label="System Instructions">
          <t-textarea
            v-model="formData.instructions"
            placeholder="You are a professional SEO content expert..."
            :autosize="{ minRows: 4, maxRows: 10 }"
          />
        </t-form-item>
        <t-form-item label="Input Parameters (optional)">
          <div class="param-editor">
            <div v-if="formData.params.length > 0" class="param-list">
              <div v-for="(param, idx) in formData.params" :key="idx" class="param-row">
                <t-input v-model="param.name" placeholder="param_name" size="small" />
                <t-select v-model="param.type" size="small" :style="{ width: '120px' }">
                  <t-option value="string" label="string" />
                  <t-option value="number" label="number" />
                  <t-option value="boolean" label="boolean" />
                </t-select>
                <t-input v-model="param.description" placeholder="description" size="small" />
                <t-checkbox v-model="param.required">Required</t-checkbox>
                <button class="param-remove" @click="removeParam(idx)">
                  <t-icon name="close" size="14px" />
                </button>
              </div>
            </div>
            <t-button theme="default" variant="outline" size="small" @click="addParam">
              <template #icon><t-icon name="add" /></template>
              Add Parameter
            </t-button>
          </div>
        </t-form-item>
        <t-form-item label="Output Format">
          <t-select v-model="formData.outputFormat" :style="{ width: '200px' }">
            <t-option value="Markdown" label="Markdown" />
            <t-option value="JSON" label="JSON" />
            <t-option value="Text" label="Text" />
          </t-select>
        </t-form-item>
        <t-alert v-if="formError" theme="error" :message="formError" class="form-alert" />
        <div class="dialog-actions">
          <t-button variant="outline" type="button" @click="createDialogVisible = false">
            Cancel
          </t-button>
          <t-button theme="primary" type="submit" :loading="formSaving">
            {{ editingSkill ? 'Save' : 'Create' }}
          </t-button>
        </div>
      </t-form>
    </t-dialog>

    <!-- 删除确认 -->
    <t-dialog
      v-model:visible="deleteDialogVisible"
      header="Delete Skill"
      :footer="false"
      width="420px"
    >
      <p class="delete-tip">
        Are you sure you want to delete "{{ deleteTarget?.name }}"? This action cannot be undone.
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

/* ========== Skill 列表 ========== */
.skill-list {
  display: flex;
  flex-direction: column;
  gap: @space-2;
}

.skill-row {
  display: flex;
  align-items: center;
  gap: @space-5;
  padding: @space-5 @space-6;
  background: @color-bg-surface;
  border: 1px solid @color-border;
  border-radius: @radius-lg;
  transition: all 180ms @ease-standard;
  animation: fade-slide-up @duration-normal @ease-out both;

  &:hover {
    border-color: @color-border-strong;
    box-shadow: @shadow-sm;

    .skill-icon {
      opacity: 1;
    }

    .row-more-btn {
      opacity: 1;
    }

    .skill-main {
      .skill-name {
        color: @primary;
      }
    }
  }

  .skill-icon {
    width: 44px;
    height: 44px;
    border-radius: @radius-md;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    flex-shrink: 0;
    transition: all 180ms @ease-standard;
    opacity: 0.8;

    &.prompt {
      background: @primary-light;
      color: @primary;
    }

    &.workflow {
      background: lighten(@color-success, 42%);
      color: @color-success;
    }

    &.tool {
      background: lighten(@color-warning, 42%);
      color: @color-warning;
    }
  }

  .skill-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    cursor: pointer;

    .skill-name {
      font-size: @font-md;
      font-weight: 600;
      color: @color-text;
      transition: color 180ms @ease-standard;
    }

    .skill-desc {
      font-size: @font-sm;
      color: @color-text-secondary;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }

  .skill-meta {
    display: flex;
    align-items: center;
    gap: @space-3;
    flex-shrink: 0;

    .type-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 2px @space-2;
      border-radius: @radius-pill;
      text-transform: uppercase;
      letter-spacing: 0.03em;

      &.prompt {
        background: @primary-light;
        color: @primary;
      }

      &.workflow {
        background: lighten(@color-success, 40%);
        color: @color-success;
      }

      &.tool {
        background: lighten(@color-warning, 40%);
        color: @color-warning;
      }
    }

    .param-count {
      font-size: @font-xs;
      color: @color-text-tertiary;
    }
  }

  .skill-updated {
    font-size: @font-xs;
    color: @color-text-tertiary;
    flex-shrink: 0;
  }

  .skill-row-actions {
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

/* ========== 参数编辑器 ========== */
.param-editor {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: @space-2;

  .param-list {
    display: flex;
    flex-direction: column;
    gap: @space-2;
    margin-bottom: @space-2;
  }

  .param-row {
    display: flex;
    align-items: center;
    gap: @space-2;

    .param-remove {
      width: 28px;
      height: 28px;
      border: none;
      background: transparent;
      border-radius: @radius-sm;
      color: @color-text-tertiary;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;

      &:hover {
        background: lighten(@color-error, 42%);
        color: @color-error;
      }
    }
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
