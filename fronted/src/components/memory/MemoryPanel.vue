<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { DialogPlugin, MessagePlugin } from "tdesign-vue-next";
import MemoryGraph from "./MemoryGraph.vue";
import {
  MEMORY_CATEGORY_COLORS,
  clearMemories,
  deleteMemory,
  getMemory,
  getMemoryGraph,
  getMemorySettings,
  listMemories,
  updateMemorySettings,
  type MemoryDetail,
  type MemoryGraphPayload,
  type MemoryListItem,
  type MemorySettings,
} from "@/api/memory";

/**
 * 记忆面板 —— 3D 发光神经网络 + 列表视图。
 *
 * 两种使用方式：
 *   - embedded：嵌在「Agent 配置 → 记忆」Tab 里（固定高度，带「全屏」按钮）
 *   - 全屏：/memory 路由，铺满内容区
 *
 * 两个视图共用同一份数据源（graph 接口）：
 *   - 星图：直观看到「助理记得什么」，按分类成扇区分布
 *   - 列表：方便批量浏览与删除
 *
 * 原文只在打开详情时请求（后端列表/图接口不返回 content），
 * 这既是隐私设计（需求 4.5），也避免一次拉几百条长文本。
 */
const props = withDefaults(defineProps<{ embedded?: boolean }>(), {
  embedded: false,
});

const router = useRouter();

const mode = ref<"graph" | "list">("graph");
const graph = ref<MemoryGraphPayload | null>(null);
const loading = ref(false);

const activeCategory = ref("");
const selectedId = ref("");
const detail = ref<MemoryDetail | null>(null);
const detailLoading = ref(false);

const listItems = ref<MemoryListItem[]>([]);
const listTotal = ref(0);
const listPage = ref(1);
const listPageSize = 20;

const settingsVisible = ref(false);
const settings = ref<MemorySettings>({
  autoCaptureEnabled: true,
  captureModelId: null,
  recallLimit: 6,
});

const categories = computed(() =>
  (graph.value?.categories ?? []).filter((c) => c.count > 0),
);

const total = computed(() => graph.value?.total ?? 0);

const categoryColor = (category: string) =>
  MEMORY_CATEGORY_COLORS[category] ?? "#94a3b8";

const loadGraph = async () => {
  loading.value = true;
  try {
    graph.value = await getMemoryGraph();
  } catch {
    MessagePlugin.error("加载记忆网络失败");
  } finally {
    loading.value = false;
  }
};

const loadList = async (page = listPage.value) => {
  try {
    const res = await listMemories({ page, pageSize: listPageSize });
    listItems.value = res.items;
    listTotal.value = res.total;
    listPage.value = res.page;
  } catch {
    MessagePlugin.error("加载记忆列表失败");
  }
};

const refreshAll = async () => {
  await Promise.all([loadGraph(), mode.value === "list" ? loadList(1) : null]);
  if (selectedId.value) {
    await openDetail(selectedId.value);
  }
};

const openDetail = async (id: string) => {
  selectedId.value = id;
  detailLoading.value = true;
  detail.value = null;
  try {
    detail.value = await getMemory(id);
  } catch {
    MessagePlugin.error("加载记忆详情失败");
    selectedId.value = "";
  } finally {
    detailLoading.value = false;
  }
};

const closeDetail = () => {
  selectedId.value = "";
  detail.value = null;
};

const handleSelect = (id: string) => {
  if (selectedId.value === id) {
    closeDetail();
    return;
  }
  void openDetail(id);
};

const handleDelete = (id: string) => {
  const dialog = DialogPlugin.confirm({
    header: "删除这条记忆",
    theme: "warning",
    body: "删除后小蝶就不会再记得这件事，且无法恢复。确定删除？",
    confirmBtn: "删除",
    onConfirm: async () => {
      dialog.destroy();
      try {
        await deleteMemory(id);
        MessagePlugin.success("已删除");
        closeDetail();
        await refreshAll();
      } catch {
        MessagePlugin.error("删除失败");
      }
    },
  });
};

const handleClearAll = () => {
  const dialog = DialogPlugin.confirm({
    header: "清空全部记忆",
    theme: "danger",
    confirmBtn: "全部清空",
    body:
      `将删除当前账号的全部 ${total.value} 条记忆及其关联关系，操作不可恢复。\n\n` +
      "小蝶会忘掉你之前告诉过它的所有事情（不影响知识库与工作流）。",
    onConfirm: async () => {
      dialog.destroy();
      try {
        const res = await clearMemories();
        MessagePlugin.success(`已清空 ${res.deleted} 条记忆`);
        closeDetail();
        await refreshAll();
      } catch {
        MessagePlugin.error("清空失败");
      }
    },
  });
};

const openSettings = async () => {
  settingsVisible.value = true;
  try {
    settings.value = await getMemorySettings();
  } catch {
    // 拦截器已提示
  }
};

const saveSettings = async () => {
  try {
    settings.value = await updateMemorySettings({
      autoCaptureEnabled: settings.value.autoCaptureEnabled,
      recallLimit: settings.value.recallLimit,
    });
    settingsVisible.value = false;
    MessagePlugin.success("已保存记忆设置");
  } catch {
    MessagePlugin.error("保存失败");
  }
};

const switchMode = (next: "graph" | "list") => {
  mode.value = next;
  if (next === "list") void loadList(1);
};

const onListPageChange = (page: { current: number }) => {
  void loadList(page.current);
};

/** 嵌在 Tab 里时提供一个「全屏」出口 —— 3D 视图空间越大越好操作 */
const openFullscreen = () => router.push("/memory");

watch(selectedId, (id) => {
  if (!id) detail.value = null;
});

onMounted(loadGraph);
</script>

<template>
  <div class="memory-panel" :class="{ 'is-embedded': props.embedded }">
    <!-- 工具栏 -->
    <div class="toolbar">
      <div class="toolbar-left">
        <span class="panel-title">记忆网络</span>
        <span class="total-badge">
          {{ total }} 条
          <span v-if="graph?.truncated" class="truncated">· 已按重要度截取前 {{ graph.nodes.length }} 条</span>
        </span>
      </div>

      <div class="category-filter">
        <button class="chip" :class="{ active: activeCategory === '' }" @click="activeCategory = ''">
          全部
        </button>
        <button v-for="c in categories" :key="c.category" class="chip"
          :class="{ active: activeCategory === c.category }" @click="activeCategory = c.category">
          <i class="dot" :style="{ background: categoryColor(c.category) }"></i>
          {{ c.label }}
          <span class="count">{{ c.count }}</span>
        </button>
      </div>

      <div class="toolbar-right">
        <div class="mode-switch">
          <button :class="{ active: mode === 'graph' }" @click="switchMode('graph')">
            <t-icon name="star" /> 星图
          </button>
          <button :class="{ active: mode === 'list' }" @click="switchMode('list')">
            <t-icon name="list" /> 列表
          </button>
        </div>
        <t-tooltip v-if="props.embedded" content="全屏查看">
          <t-button variant="text" shape="square" @click="openFullscreen">
            <t-icon name="fullscreen" />
          </t-button>
        </t-tooltip>
        <t-tooltip content="记忆设置">
          <t-button variant="text" shape="square" @click="openSettings">
            <t-icon name="setting" />
          </t-button>
        </t-tooltip>
        <t-tooltip content="刷新">
          <t-button variant="text" shape="square" :loading="loading" @click="refreshAll">
            <t-icon name="refresh" />
          </t-button>
        </t-tooltip>
        <t-button theme="danger" variant="outline" size="small" :disabled="total === 0" @click="handleClearAll">
          清空
        </t-button>
      </div>
    </div>

    <!-- 舞台 -->
    <div class="stage" :class="{ 'is-list': mode === 'list' }">
      <!-- 星图 -->
      <MemoryGraph v-if="mode === 'graph'" :nodes="graph?.nodes ?? []" :links="graph?.links ?? []"
        :active-category="activeCategory" :selected-id="selectedId" @select="handleSelect" />

      <!-- 列表 -->
      <div v-else class="list-view">
        <div v-if="listItems.length === 0" class="list-empty">
          还没有任何记忆。和小蝶聊几句，重要的内容会被自动记住。
        </div>
        <div v-for="item in listItems" :key="item.id" class="memory-card"
          :class="{ active: selectedId === item.id }" @click="openDetail(item.id)">
          <div class="card-head">
            <span class="cat-tag"
              :style="{ color: categoryColor(item.category), borderColor: categoryColor(item.category) + '55' }">
              {{ item.categoryLabel }}
            </span>
            <span class="card-time">{{ new Date(item.createdAt).toLocaleString() }}</span>
          </div>
          <p class="card-summary">{{ item.summary }}</p>
          <div class="card-foot">
            <div class="importance">
              <span class="imp-bar">
                <i
                  :style="{ width: `${Math.round(item.importance * 100)}%`, background: categoryColor(item.category) }"></i>
              </span>
              <span class="imp-text">重要度 {{ item.importance.toFixed(2) }}</span>
            </div>
            <t-button variant="text" theme="danger" size="small" @click.stop="handleDelete(item.id)">
              删除
            </t-button>
          </div>
        </div>
        <div v-if="listTotal > listPageSize" class="list-pagination">
          <t-pagination :current="listPage" :total="listTotal" :page-size="listPageSize"
            @change="onListPageChange" />
        </div>
      </div>

      <!-- 图例（仅星图模式） -->
      <div v-if="mode === 'graph' && categories.length > 0" class="legend">
        <div v-for="c in categories" :key="c.category" class="legend-item">
          <i class="dot" :style="{ background: categoryColor(c.category), boxShadow: `0 0 8px ${categoryColor(c.category)}` }"></i>
          <span>{{ c.label }}</span>
        </div>
        <p class="legend-hint">拖拽旋转 · 滚轮缩放 · 点击节点查看</p>
      </div>

      <!-- 详情面板 -->
      <transition name="panel">
        <aside v-if="selectedId" class="detail-panel">
          <header class="panel-head">
            <span v-if="detail" class="cat-tag"
              :style="{ color: categoryColor(detail.category), borderColor: categoryColor(detail.category) + '55' }">
              {{ detail.categoryLabel }}
            </span>
            <span v-else class="cat-tag">加载中</span>
            <button class="panel-close" @click="closeDetail">
              <t-icon name="close" />
            </button>
          </header>

          <div v-if="detailLoading" class="panel-loading">
            <t-icon name="loading" spin />
            <span>读取中…</span>
          </div>

          <div v-else-if="detail" class="panel-body">
            <h3 class="panel-summary">{{ detail.summary }}</h3>

            <div class="panel-meta">
              <div class="meta-row">
                <span class="meta-label">重要度</span>
                <span class="meta-value">{{ detail.importance.toFixed(2) }}</span>
              </div>
              <div class="meta-row">
                <span class="meta-label">形成时间</span>
                <span class="meta-value">{{ new Date(detail.createdAt).toLocaleString() }}</span>
              </div>
              <div class="meta-row">
                <span class="meta-label">被召回</span>
                <span class="meta-value">{{ detail.accessCount }} 次</span>
              </div>
            </div>

            <div class="panel-section">
              <h4>记忆原文</h4>
              <p class="panel-content">{{ detail.content }}</p>
            </div>

            <div class="panel-actions">
              <t-button theme="danger" variant="outline" size="small" block @click="handleDelete(detail.id)">
                删除这条记忆
              </t-button>
            </div>
          </div>
        </aside>
      </transition>
    </div>

    <!-- 记忆设置 -->
    <t-dialog v-model:visible="settingsVisible" header="记忆设置" :footer="false" width="440px">
      <div class="settings-body">
        <div class="setting-row">
          <div>
            <span class="setting-title">自动沉淀记忆</span>
            <p class="setting-hint">对话结束后自动提取值得记住的内容；关闭后不再新增记忆（已有记忆不受影响）。</p>
          </div>
          <t-switch v-model="settings.autoCaptureEnabled" />
        </div>

        <div class="setting-row column">
          <div class="setting-head">
            <span class="setting-title">召回条数</span>
            <span class="setting-value">{{ settings.recallLimit }} 条</span>
          </div>
          <t-slider v-model="settings.recallLimit" :min="1" :max="10" :step="1" />
          <p class="setting-hint">每次对话注入上下文的相关记忆条数。条数越多越「记得清楚」，也越占上下文。</p>
        </div>

        <div class="settings-actions">
          <t-button variant="outline" @click="settingsVisible = false">取消</t-button>
          <t-button theme="primary" @click="saveSettings">保存</t-button>
        </div>
      </div>
    </t-dialog>
  </div>
</template>

<style scoped lang="less">
@import "../../styles/variables.less";

/* 全屏模式：铺满内容区 */
.memory-panel {
  display: flex;
  flex-direction: column;
  height: calc(100vh - @header-height);
  overflow: hidden;
}

/* 嵌入模式：固定高度 + 圆角边框，Tab 里不会把页面撑爆 */
.memory-panel.is-embedded {
  height: 660px;
  border: 1px solid @color-border;
  border-radius: @radius-card;
  overflow: hidden;
  background: @color-bg-surface;
}

/* ---------- 工具栏 ---------- */
.toolbar {
  display: flex;
  align-items: center;
  gap: @space-3;
  padding: @space-3 @space-4;
  border-bottom: 1px solid @color-border;
  background: @color-bg-surface;
  flex-shrink: 0;
  flex-wrap: wrap;
}

.toolbar-left {
  display: flex;
  align-items: baseline;
  gap: @space-3;

  .panel-title {
    font-size: @font-md;
    font-weight: 600;
    color: @color-text;
  }

  .total-badge {
    font-size: @font-xs;
    color: @color-text-tertiary;

    .truncated {
      margin-left: @space-1;
      color: @color-warning;
    }
  }
}

.category-filter {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  flex-wrap: wrap;
  min-width: 0;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: @radius-pill;
  border: 1px solid @color-border;
  background: transparent;
  color: @color-text-secondary;
  font-size: @font-xs;
  cursor: pointer;
  transition: all @duration-fast @ease-standard;

  &:hover {
    border-color: @primary;
    color: @primary;
  }

  &.active {
    background: @primary-light;
    border-color: @primary;
    color: @primary;
    font-weight: 600;
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    display: inline-block;
  }

  .count {
    opacity: 0.65;
    font-variant-numeric: tabular-nums;
  }
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: @space-1;
  margin-left: auto;
}

.mode-switch {
  display: inline-flex;
  padding: 2px;
  border-radius: @radius-md;
  background: @color-bg-hover;
  margin-right: @space-2;

  button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 10px;
    border: none;
    border-radius: @radius-sm;
    background: transparent;
    color: @color-text-secondary;
    font-size: @font-xs;
    cursor: pointer;
    transition: all @duration-fast;

    &.active {
      background: @color-bg-surface;
      color: @primary;
      font-weight: 600;
      box-shadow: @shadow-xs;
    }
  }
}

/* ---------- 舞台（深色宇宙）---------- */
.stage {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background:
    radial-gradient(ellipse at 50% 45%, rgba(76, 29, 149, 0.35) 0%, rgba(15, 23, 42, 0) 55%),
    radial-gradient(ellipse at 80% 80%, rgba(30, 64, 175, 0.22) 0%, rgba(15, 23, 42, 0) 50%),
    #06070f;

  &.is-list {
    background: @color-bg;
    overflow-y: auto;
    padding: @space-5;
  }
}

/* ---------- 列表 ---------- */
.list-view {
  display: flex;
  flex-direction: column;
  gap: @space-3;
  max-width: 900px;
  margin: 0 auto;
}

.list-empty {
  padding: @space-16;
  text-align: center;
  color: @color-text-tertiary;
  font-size: @font-sm;
}

.memory-card {
  background: @color-bg-surface;
  border: 1px solid @color-border;
  border-radius: @radius-card;
  padding: @space-4;
  cursor: pointer;
  transition: all @duration-fast @ease-standard;

  &:hover {
    border-color: @primary;
    box-shadow: @shadow-sm;
  }

  &.active {
    border-color: @primary;
    background: @primary-glow;
  }

  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: @space-2;

    .card-time {
      font-size: @font-xs;
      color: @color-text-tertiary;
    }
  }

  .card-summary {
    margin: 0 0 @space-3;
    font-size: @font-base;
    color: @color-text;
    line-height: 1.6;
  }

  .card-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .importance {
    display: flex;
    align-items: center;
    gap: @space-2;

    .imp-bar {
      width: 72px;
      height: 4px;
      border-radius: @radius-pill;
      background: @color-bg-hover;
      overflow: hidden;
      display: inline-block;

      i {
        display: block;
        height: 100%;
        border-radius: @radius-pill;
      }
    }

    .imp-text {
      font-size: @font-xs;
      color: @color-text-tertiary;
    }
  }
}

.list-pagination {
  display: flex;
  justify-content: center;
  padding: @space-4 0;
}

.cat-tag {
  display: inline-block;
  padding: 2px 10px;
  border-radius: @radius-pill;
  border: 1px solid currentColor;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

/* ---------- 图例 ---------- */
.legend {
  position: absolute;
  left: @space-4;
  bottom: @space-4;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: @space-2 @space-3;
  border-radius: @radius-lg;
  background: rgba(9, 12, 24, 0.62);
  border: 1px solid rgba(148, 163, 184, 0.16);
  backdrop-filter: blur(8px);
  pointer-events: none;

  .legend-item {
    display: flex;
    align-items: center;
    gap: @space-2;
    font-size: 11px;
    color: rgba(226, 232, 240, 0.85);

    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
    }
  }

  .legend-hint {
    margin: @space-1 0 0;
    font-size: 10px;
    color: rgba(148, 163, 184, 0.7);
  }
}

/* ---------- 详情面板 ---------- */
.detail-panel {
  position: absolute;
  top: @space-3;
  right: @space-3;
  bottom: @space-3;
  width: 340px;
  display: flex;
  flex-direction: column;
  border-radius: @radius-card;
  background: rgba(10, 14, 26, 0.9);
  border: 1px solid rgba(148, 163, 184, 0.18);
  backdrop-filter: blur(14px);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
  overflow: hidden;

  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: @space-3 @space-4;
    border-bottom: 1px solid rgba(148, 163, 184, 0.14);
  }

  .panel-close {
    border: none;
    background: transparent;
    color: rgba(203, 213, 225, 0.7);
    cursor: pointer;
    font-size: 16px;
    display: flex;

    &:hover {
      color: #fff;
    }
  }

  .panel-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: @space-2;
    padding: @space-12;
    color: rgba(148, 163, 184, 0.8);
    font-size: @font-sm;
  }

  .panel-body {
    padding: @space-4;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: @space-4;
  }

  .panel-summary {
    margin: 0;
    font-size: @font-md;
    font-weight: 600;
    line-height: 1.6;
    color: #e2e8f0;
  }

  .panel-meta {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: @space-3;
    border-radius: @radius-md;
    background: rgba(148, 163, 184, 0.08);

    .meta-row {
      display: flex;
      justify-content: space-between;
      font-size: @font-xs;
    }

    .meta-label {
      color: rgba(148, 163, 184, 0.85);
    }

    .meta-value {
      color: rgba(226, 232, 240, 0.92);
      font-weight: 500;
    }
  }

  .panel-section h4 {
    margin: 0 0 @space-2;
    font-size: @font-xs;
    font-weight: 600;
    color: rgba(148, 163, 184, 0.9);
    letter-spacing: 0.04em;
  }

  .panel-content {
    margin: 0;
    font-size: @font-sm;
    line-height: 1.75;
    color: rgba(226, 232, 240, 0.88);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .panel-actions {
    margin-top: auto;
    padding-top: @space-2;
  }
}

.panel-enter-active,
.panel-leave-active {
  transition: transform @duration-normal @ease-out, opacity @duration-normal;
}

.panel-enter-from,
.panel-leave-to {
  transform: translateX(16px);
  opacity: 0;
}

/* ---------- 设置弹窗 ---------- */
.settings-body {
  display: flex;
  flex-direction: column;
  gap: @space-5;
}

.setting-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: @space-4;

  &.column {
    flex-direction: column;
    gap: @space-2;
  }

  .setting-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
  }

  .setting-title {
    font-size: @font-sm;
    font-weight: 600;
    color: @color-text;
  }

  .setting-value {
    font-size: @font-xs;
    color: @primary;
    font-weight: 600;
  }

  .setting-hint {
    margin: 4px 0 0;
    font-size: @font-xs;
    color: @color-text-tertiary;
    line-height: 1.55;
  }
}

.settings-actions {
  display: flex;
  justify-content: flex-end;
  gap: @space-3;
  padding-top: @space-2;
  border-top: 1px solid @color-border;
}

@media (max-width: 900px) {
  .detail-panel {
    width: auto;
    left: @space-3;
  }
}
</style>
