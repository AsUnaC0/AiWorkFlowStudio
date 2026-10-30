<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { DialogPlugin, MessagePlugin } from "tdesign-vue-next";
import {
  getPersona,
  getPersonaOptions,
  resetPersona,
  updatePersona,
  type PersonaOptions,
  type PersonaProfile,
} from "@/api/persona";

/**
 * 人格配置面板 —— 嵌在「Agent 配置」页的「人格」Tab 里。
 *
 * 只对平台默认助理开放（isSystem && isDefault）：
 *   - 父组件按 isSystem && isDefault 决定是否渲染这个 Tab
 *   - 后端 PersonaService 会再校验一次，非平台助理一律 403
 * 所以这里不做权限判断，只负责表单。
 *
 * 人格是「表达层」：只改语气、措辞、音色，不改工具白名单与权限。
 */
const props = defineProps<{ agentId: string }>();

const persona = ref<PersonaProfile | null>(null);
const loading = ref(false);
const saving = ref(false);

const options = ref<PersonaOptions>({
  voices: [],
  frequencies: [],
  limits: { nameMax: 24, tagMax: 12, tagsMax: 8, promptMax: 8000 },
});

const form = reactive({
  name: "小蝶",
  tags: [] as string[],
  systemPrompt: "",
  voiceEnabled: true,
  voiceId: "zh-CN-XiaoyiNeural",
  speechRate: 1,
  pitch: 1,
  desktopPetEnabled: false,
  proactiveChatEnabled: false,
  proactiveChatFrequency: "low",
  screenPerceptionEnabled: false,
  screenPerceptionInterval: 60,
});

const applyPersona = (p: PersonaProfile) => {
  persona.value = p;
  form.name = p.name;
  form.tags = [...p.tags];
  form.systemPrompt = p.systemPrompt;
  form.voiceEnabled = p.voiceEnabled;
  form.voiceId = p.voiceId;
  form.speechRate = p.speechRate;
  form.pitch = p.pitch;
  form.desktopPetEnabled = p.desktopPetEnabled;
  form.proactiveChatEnabled = p.proactiveChatEnabled;
  form.proactiveChatFrequency = p.proactiveChatFrequency;
  form.screenPerceptionEnabled = p.screenPerceptionEnabled;
  form.screenPerceptionInterval = p.screenPerceptionInterval;
};

const load = async () => {
  if (!props.agentId) return;
  loading.value = true;
  try {
    const [p, opts] = await Promise.all([
      getPersona(props.agentId),
      getPersonaOptions(props.agentId),
    ]);
    options.value = opts;
    applyPersona(p);
  } catch {
    MessagePlugin.error("加载人格配置失败");
  } finally {
    loading.value = false;
  }
};

onMounted(load);

/** 表单是否有改动 —— 没改动时禁用保存，避免无意义的 personaVersion 自增 */
const dirty = computed(() => {
  const p = persona.value;
  if (!p) return false;
  return (
    form.name !== p.name ||
    JSON.stringify(form.tags) !== JSON.stringify(p.tags) ||
    form.systemPrompt !== p.systemPrompt ||
    form.voiceEnabled !== p.voiceEnabled ||
    form.voiceId !== p.voiceId ||
    form.speechRate !== p.speechRate ||
    form.pitch !== p.pitch ||
    form.desktopPetEnabled !== p.desktopPetEnabled ||
    form.proactiveChatEnabled !== p.proactiveChatEnabled ||
    form.proactiveChatFrequency !== p.proactiveChatFrequency ||
    form.screenPerceptionEnabled !== p.screenPerceptionEnabled ||
    form.screenPerceptionInterval !== p.screenPerceptionInterval
  );
});

const handleSave = async () => {
  if (!props.agentId) return;
  if (!form.name.trim()) {
    MessagePlugin.warning("人格名字不能为空");
    return;
  }
  if (!form.systemPrompt.trim()) {
    MessagePlugin.warning("人格提示词不能为空");
    return;
  }

  saving.value = true;
  try {
    const saved = await updatePersona(props.agentId, {
      name: form.name.trim(),
      tags: form.tags,
      systemPrompt: form.systemPrompt,
      voiceEnabled: form.voiceEnabled,
      voiceId: form.voiceId,
      speechRate: form.speechRate,
      pitch: form.pitch,
      desktopPetEnabled: form.desktopPetEnabled,
      proactiveChatEnabled: form.proactiveChatEnabled,
      proactiveChatFrequency: form.proactiveChatFrequency,
      screenPerceptionEnabled: form.screenPerceptionEnabled,
      screenPerceptionInterval: form.screenPerceptionInterval,
    });
    applyPersona(saved);
    MessagePlugin.success(`已保存（人格 v${saved.personaVersion}）`);
  } catch {
    MessagePlugin.error("保存失败");
  } finally {
    saving.value = false;
  }
};

const handleReset = () => {
  const dialog = DialogPlugin.confirm({
    header: "恢复默认人格",
    theme: "warning",
    confirmBtn: "恢复默认",
    body: "会重置名字、标签、提示词、音色与全部行为开关（回到「小蝶」的出厂设定）。此操作立即生效，确定继续？",
    onConfirm: async () => {
      dialog.destroy();
      if (!props.agentId) return;
      try {
        const p = await resetPersona(props.agentId);
        applyPersona(p);
        MessagePlugin.success("已恢复默认人格");
      } catch {
        MessagePlugin.error("恢复失败");
      }
    },
  });
};

/**
 * 截屏感知开关必须二次确认（需求 3.5 / 第 6 章）。
 *
 * 所以这里不是普通的 v-model 开关：点开先弹窗，确认才真正写值。
 */
const onPerceptionToggle = (value: boolean) => {
  if (!value) {
    form.screenPerceptionEnabled = false;
    return;
  }
  const dialog = DialogPlugin.confirm({
    header: "开启截屏感知",
    theme: "warning",
    confirmBtn: "我已了解，开启",
    cancelBtn: "取消",
    body:
      "开启后，桌宠会按间隔截取一张低分辨率屏幕缩略图，交给视觉模型判断你正在做什么" +
      "（写代码 / 看视频 / 开会 / 空闲），用来决定要不要主动搭话。\n\n" +
      "· 只上传缩略图，原始截图不落盘、不写日志\n" +
      "· 判断结果用完即丢，不建持久表\n" +
      "· 你随时可以在本页或桌宠托盘一键关闭",
    onConfirm: () => {
      form.screenPerceptionEnabled = true;
      dialog.destroy();
    },
    onCancel: () => dialog.destroy(),
    onClose: () => dialog.destroy(),
  });
};

const frequencyOptions = computed(() =>
  options.value.frequencies.map((f) => ({
    value: f.value,
    label: f.label,
  })),
);

const voiceOptions = computed(() =>
  options.value.voices.map((v) => ({
    value: v.id,
    label: `${v.label} · ${v.description}`,
  })),
);
</script>

<template>
  <div class="persona-panel">
    <div class="panel-toolbar">
      <p class="toolbar-text">
        人格是平台助理的<strong>表达层</strong>：决定「怎么说」，不改变「能做什么」。
        工具白名单、风险等级、权限校验与审计一律不受影响。
      </p>
      <div class="toolbar-actions">
        <t-button variant="outline" size="small" :disabled="loading" @click="handleReset">
          <template #icon><t-icon name="rollback" /></template>
          恢复默认
        </t-button>
        <t-button theme="primary" size="small" :loading="saving" :disabled="!dirty" @click="handleSave">
          <template #icon><t-icon name="save" /></template>
          保存人格
        </t-button>
      </div>
    </div>

    <div v-if="loading" class="loading-state">
      <t-icon name="loading" spin />
      <span>加载中…</span>
    </div>

    <div v-else class="persona-body">
      <!-- 左列：身份 + 提示词 -->
      <div class="col-main">
        <section class="card">
          <h2 class="section-title">身份</h2>
          <div class="field">
            <label>名字</label>
            <t-input v-model="form.name" :maxlength="options.limits.nameMax" placeholder="小蝶" />
            <p class="hint">
              这个名字会出现在聊天页、记忆页与桌宠上。
              系统标识仍是「平台助理」，改名不影响任何能力。
            </p>
          </div>
          <div class="field">
            <label>标签</label>
            <t-tag-input v-model="form.tags" :max="options.limits.tagsMax" placeholder="回车添加标签" />
            <p class="hint">标签只用于展示与语气提示，不会注入工具调用逻辑。</p>
          </div>
        </section>

        <section class="card">
          <h2 class="section-title">
            人格提示词
            <span class="section-hint">告诉它「你是谁、怎么说话」</span>
          </h2>
          <t-textarea v-model="form.systemPrompt" class="prompt-area" placeholder="你是……"
            :autosize="{ minRows: 14, maxRows: 26 }" />
          <div class="prompt-foot">
            <span>{{ form.systemPrompt.length }} / {{ options.limits.promptMax }}</span>
          </div>
          <t-alert theme="info" :close="false">
            <template #message>
              这段提示词只影响语气、措辞与打字节奏。服务端会在它前后自动追加边界声明，
              因此「不承认自己是程序」不会削弱身份判定、风险确认与审计。
            </template>
          </t-alert>
        </section>
      </div>

      <!-- 右列：语音 / 主动行为 / 隐私 -->
      <aside class="col-side">
        <section class="card">
          <h2 class="section-title">语音</h2>
          <div class="switch-row">
            <div class="switch-label">
              <span>语音说话</span>
              <p class="hint">关闭后只出文字气泡，不出声</p>
            </div>
            <t-switch v-model="form.voiceEnabled" />
          </div>
          <div class="field">
            <label>音色</label>
            <t-select v-model="form.voiceId" :options="voiceOptions" :disabled="!form.voiceEnabled"
              placeholder="选择音色，或直接输入 voiceId" creatable filterable />
            <p class="hint">
              内置为 Edge 音色；要换成 BreezeBlue 音色，直接把 voiceId（形如
              <code>voc_xxx</code>）填进来即可，桌宠会自动走后端合成。
            </p>
          </div>
          <div class="field">
            <label>语速 {{ form.speechRate.toFixed(1) }}</label>
            <t-slider v-model="form.speechRate" :min="0.5" :max="2" :step="0.1"
              :disabled="!form.voiceEnabled" />
          </div>
          <div class="field">
            <label>音调 {{ form.pitch.toFixed(1) }}</label>
            <t-slider v-model="form.pitch" :min="0.5" :max="2" :step="0.1" :disabled="!form.voiceEnabled" />
            <p class="hint">音调略高会更「甜美」，过高会失真。</p>
          </div>
        </section>

        <section class="card">
          <h2 class="section-title">主动行为</h2>
          <div class="switch-row">
            <div class="switch-label">
              <span>主动搭话</span>
              <p class="hint">默认关闭，开启后按频率限频</p>
            </div>
            <t-switch v-model="form.proactiveChatEnabled" />
          </div>
          <div class="field">
            <label>频率</label>
            <t-select v-model="form.proactiveChatFrequency" :options="frequencyOptions"
              :disabled="!form.proactiveChatEnabled" />
            <p class="hint">全屏 / 会议场景会自动抑制打扰。</p>
          </div>
          <div class="switch-row">
            <div class="switch-label">
              <span>允许显示桌宠</span>
              <p class="hint">开启后桌面客户端才能加载形象</p>
            </div>
            <t-switch v-model="form.desktopPetEnabled" />
          </div>
        </section>

        <section class="card">
          <h2 class="section-title">截屏感知</h2>
          <div class="switch-row">
            <div class="switch-label">
              <span>允许截屏感知</span>
              <p class="hint">默认关闭，开启需二次确认</p>
            </div>
            <!-- 不用 v-model：开启必须先经过确认弹窗 -->
            <t-switch :value="form.screenPerceptionEnabled" @change="onPerceptionToggle" />
          </div>
          <div class="field">
            <label>感知间隔（秒）</label>
            <t-input-number v-model="form.screenPerceptionInterval" :min="30" :max="3600" :step="10"
              :disabled="!form.screenPerceptionEnabled" theme="normal" />
          </div>
          <div class="privacy-note">
            <t-icon name="lock-on" />
            <span>
              只上传低分辨率缩略图，原始截图不落盘、不写日志；
              判断结果在完成对应行为后立即丢弃，不建持久表。
            </span>
          </div>
        </section>

        <section class="card meta">
          <div class="meta-row">
            <span class="meta-label">人格版本</span>
            <span class="meta-value">v{{ persona?.personaVersion ?? 1 }}</span>
          </div>
          <div class="meta-row">
            <span class="meta-label">保存状态</span>
            <t-tag :theme="dirty ? 'warning' : 'success'" variant="light" size="small">
              {{ dirty ? "有未保存修改" : "已保存" }}
            </t-tag>
          </div>
          <div class="meta-row">
            <span class="meta-label">最近更新</span>
            <span class="meta-value">
              {{ persona?.updatedAt ? new Date(persona.updatedAt).toLocaleString() : "尚未保存过" }}
            </span>
          </div>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped lang="less">
@import "../../../styles/variables.less";

.panel-toolbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: @space-5;
  padding-bottom: @space-4;
  margin-bottom: @space-5;
  border-bottom: 1px solid @color-border;

  .toolbar-text {
    margin: 0;
    font-size: @font-sm;
    color: @color-text-secondary;
    line-height: 1.6;
    max-width: 620px;
  }

  .toolbar-actions {
    display: flex;
    gap: @space-2;
    flex-shrink: 0;
  }
}

.persona-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: @space-5;
  align-items: start;
}

.col-main,
.col-side {
  display: flex;
  flex-direction: column;
  gap: @space-4;
  min-width: 0;
}

.card {
  background: @color-bg-surface;
  border: 1px solid @color-border;
  border-radius: @radius-card;
  padding: @space-5;
  box-shadow: @shadow-xs;
}

.section-title {
  display: flex;
  align-items: baseline;
  gap: @space-2;
  margin-bottom: @space-4;

  .section-hint {
    font-size: @font-xs;
    font-weight: 400;
    color: @color-text-tertiary;
  }
}

.field {
  display: flex;
  flex-direction: column;
  gap: @space-2;
  margin-bottom: @space-4;

  &:last-child {
    margin-bottom: 0;
  }

  label {
    font-size: @font-xs;
    font-weight: 500;
    color: @color-text-secondary;
  }
}

.hint {
  font-size: @font-xs;
  color: @color-text-tertiary;
  line-height: 1.5;
  margin: 0;
}

.prompt-area {
  :deep(.t-textarea__inner) {
    font-family: @font-mono;
    font-size: 13px;
    line-height: 1.7;
  }
}

.prompt-foot {
  display: flex;
  justify-content: flex-end;
  font-size: @font-xs;
  color: @color-text-tertiary;
  margin: @space-2 0 @space-3;
}

.switch-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: @space-4;
  padding: @space-3 0;
  border-bottom: 1px dashed @color-border;

  &:last-of-type {
    border-bottom: none;
  }

  .switch-label {
    min-width: 0;

    span {
      font-size: @font-sm;
      font-weight: 500;
      color: @color-text;
    }
  }
}

.privacy-note {
  display: flex;
  gap: @space-2;
  align-items: flex-start;
  padding: @space-3;
  border-radius: @radius-md;
  background: @primary-glow;
  font-size: @font-xs;
  color: @color-text-secondary;
  line-height: 1.6;

  :deep(.t-icon) {
    color: @primary;
    flex-shrink: 0;
    margin-top: 2px;
  }
}

.card.meta {
  display: flex;
  flex-direction: column;
  gap: @space-3;
  background: @color-bg-hover;
  box-shadow: none;

  .meta-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: @space-3;
  }

  .meta-label {
    font-size: @font-xs;
    color: @color-text-tertiary;
  }

  .meta-value {
    font-size: @font-xs;
    color: @color-text-secondary;
    font-weight: 500;
  }
}

.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: @space-3;
  padding: @space-16;
  color: @color-text-tertiary;
}

@media (max-width: 1080px) {
  .persona-body {
    grid-template-columns: 1fr;
  }
}
</style>
