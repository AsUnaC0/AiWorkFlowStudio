<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, nextTick } from "vue";
import * as echarts from "echarts";
import { MessagePlugin } from "tdesign-vue-next";
import {
  getOverview,
  getWorkflowTrend,
  getWorkflowStatus,
  getNodePerformance,
  getKnowledgeStatus,
  getRecentActivities,
  getQueueOverview,
  type DashboardOverview,
  type WorkflowTrendItem,
  type WorkflowStatusMap,
  type NodePerformanceItem,
  type KnowledgeStatus,
  type RecentActivities,
  type QueueOverview,
} from "@/api/dashboard";

// ===========================================================================
// 数据状态
// ===========================================================================
const loading = ref(true);
const errorMessage = ref("");
const lastUpdated = ref<Date | null>(null);
const refreshing = ref(false);
const timeRange = ref<"7" | "14" | "30">("7");

const overview = ref<DashboardOverview | null>(null);
const trend = ref<WorkflowTrendItem[]>([]);
const statusMap = ref<WorkflowStatusMap | null>(null);
const nodePerformance = ref<NodePerformanceItem[]>([]);
const knowledgeStatus = ref<KnowledgeStatus | null>(null);
const recentActivities = ref<RecentActivities | null>(null);
const queueOverview = ref<QueueOverview | null>(null);

// ===========================================================================
// ECharts 实例管理
// ===========================================================================
const chartRefs = {
  trend: ref<HTMLDivElement>(),
  status: ref<HTMLDivElement>(),
  node: ref<HTMLDivElement>(),
  knowledge: ref<HTMLDivElement>(),
  queue: ref<HTMLDivElement>(),
};
const charts: Record<string, echarts.ECharts | null> = {
  trend: null,
  status: null,
  node: null,
  knowledge: null,
  queue: null,
};
let resizeTimer: number | null = null;

// ===========================================================================
// 数据加载
// ===========================================================================
const loadAll = async () => {
  loading.value = true;
  errorMessage.value = "";

  try {
    const results = await Promise.allSettled([
      getOverview(),
      getWorkflowTrend(parseInt(timeRange.value)),
      getWorkflowStatus(parseInt(timeRange.value)),
      getNodePerformance(),
      getKnowledgeStatus(),
      getRecentActivities(10),
      getQueueOverview(),
    ]);

    const apis = [
      { key: "overview", idx: 0, setter: (v: unknown) => (overview.value = v as DashboardOverview) },
      { key: "trend", idx: 1, setter: (v: unknown) => (trend.value = v as WorkflowTrendItem[]) },
      { key: "status", idx: 2, setter: (v: unknown) => (statusMap.value = v as WorkflowStatusMap) },
      { key: "node", idx: 3, setter: (v: unknown) => (nodePerformance.value = v as NodePerformanceItem[]) },
      { key: "knowledge", idx: 4, setter: (v: unknown) => (knowledgeStatus.value = v as KnowledgeStatus) },
      { key: "activities", idx: 5, setter: (v: unknown) => (recentActivities.value = v as RecentActivities) },
      { key: "queue", idx: 6, setter: (v: unknown) => (queueOverview.value = v as QueueOverview) },
    ];

    const failedNames: string[] = [];
    for (const api of apis) {
      const r = results[api.idx];
      if (r.status === "fulfilled") {
        api.setter(r.value);
      } else {
        failedNames.push(api.key);
      }
    }

    if (failedNames.length > 0) {
      MessagePlugin.warning(`部分数据加载失败（${failedNames.length} 项），请稍后刷新重试`);
    }

    lastUpdated.value = new Date();
    await nextTick();
    renderAllCharts();
  } catch {
    errorMessage.value = "数据加载失败，请稍后重试";
  } finally {
    loading.value = false;
  }
};

const handleRefresh = async () => {
  refreshing.value = true;
  await loadAll();
  refreshing.value = false;
  MessagePlugin.success("数据已刷新");
};

const handleTimeRangeChange = async () => {
  await loadAll();
};

// ===========================================================================
// ECharts 渲染
// ===========================================================================
const renderAllCharts = () => {
  renderTrendChart();
  renderStatusChart();
  renderNodeChart();
  renderKnowledgeChart();
  renderQueueChart();
};

const disposeAllCharts = () => {
  Object.values(charts).forEach((c) => c?.dispose());
  Object.keys(charts).forEach((k) => (charts[k] = null));
};

const handleResize = () => {
  if (resizeTimer) window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    Object.values(charts).forEach((c) => c?.resize());
  }, 200);
};

// ---- 1. 工作流执行趋势（折线 + 面积）----
const renderTrendChart = () => {
  if (!chartRefs.trend.value || trend.value.length === 0) return;
  charts.trend?.dispose();
  charts.trend = echarts.init(chartRefs.trend.value);

  const dates = trend.value.map((t) => t.date.slice(5));
  charts.trend.setOption({
    tooltip: { trigger: "axis" },
    legend: {
      data: ["总执行", "成功", "失败"],
      right: 0,
      top: 0,
      textStyle: { color: "#71717A", fontSize: 12 },
    },
    grid: { top: 36, right: 16, bottom: 24, left: 32 },
    xAxis: {
      type: "category",
      data: dates,
      axisLine: { lineStyle: { color: "#E8EAF0" } },
      axisLabel: { color: "#A1A1AA", fontSize: 11 },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      splitLine: { lineStyle: { color: "#F4F4F5" } },
      axisLabel: { color: "#A1A1AA", fontSize: 11 },
    },
    series: [
      {
        name: "总执行",
        type: "line",
        smooth: true,
        symbol: "circle",
        symbolSize: 6,
        data: trend.value.map((t) => t.total),
        lineStyle: { color: "#7C5CFC", width: 2 },
        itemStyle: { color: "#7C5CFC" },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: "rgba(124,92,252,0.18)" },
            { offset: 1, color: "rgba(124,92,252,0)" },
          ]),
        },
      },
      {
        name: "成功",
        type: "line",
        smooth: true,
        symbol: "circle",
        symbolSize: 6,
        data: trend.value.map((t) => t.success),
        lineStyle: { color: "#2BA471", width: 2 },
        itemStyle: { color: "#2BA471" },
      },
      {
        name: "失败",
        type: "line",
        smooth: true,
        symbol: "circle",
        symbolSize: 6,
        data: trend.value.map((t) => t.failed),
        lineStyle: { color: "#D54941", width: 2 },
        itemStyle: { color: "#D54941" },
      },
    ],
  });
};

// ---- 2. 运行结果分布（环形图）----
const renderStatusChart = () => {
  if (!chartRefs.status.value || !statusMap.value) return;
  charts.status?.dispose();
  charts.status = echarts.init(chartRefs.status.value);

  const statusOrder: Array<[string, string, string]> = [
    ["COMPLETED", "已完成", "#2BA471"],
    ["FAILED", "失败", "#D54941"],
    ["RUNNING", "运行中", "#7C5CFC"],
    ["QUEUED", "排队中", "#E37318"],
  ];
  const data = statusOrder
    .map(([key, name, color]) => ({
      value: statusMap.value![key] ?? 0,
      name,
      itemStyle: { color },
    }))
    .filter((d) => d.value > 0);

  if (data.length === 0) {
    charts.status.setOption({
      title: { text: "暂无数据", left: "center", top: "center", textStyle: { color: "#A1A1AA", fontSize: 13 } },
    });
    return;
  }

  charts.status.setOption({
    tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
    legend: {
      orient: "vertical",
      right: 8,
      top: "center",
      textStyle: { color: "#71717A", fontSize: 12 },
    },
    series: [
      {
        type: "pie",
        radius: ["48%", "72%"],
        center: ["38%", "50%"],
        itemStyle: { borderRadius: 4, borderColor: "#fff", borderWidth: 2 },
        label: { show: false },
        emphasis: { label: { show: true, fontSize: 14, fontWeight: "bold" } },
        data,
      },
    ],
  });
};

// ---- 3. 节点耗时排行（横向柱状图）----
const renderNodeChart = () => {
  if (!chartRefs.node.value || nodePerformance.value.length === 0) return;
  charts.node?.dispose();
  charts.node = echarts.init(chartRefs.node.value);

  const sorted = [...nodePerformance.value].sort((a, b) => b.avgDurationMs - a.avgDurationMs);
  const types = sorted.map((n) => n.nodeType).reverse();
  const durations = sorted.map((n) => n.avgDurationMs).reverse();

  charts.node.setOption({
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    grid: { top: 8, right: 30, bottom: 8, left: 80 },
    xAxis: {
      type: "value",
      splitLine: { lineStyle: { color: "#F4F4F5" } },
      axisLabel: { color: "#A1A1AA", fontSize: 11, formatter: "{value} ms" },
    },
    yAxis: {
      type: "category",
      data: types,
      axisLine: { show: false },
      axisLabel: { color: "#18181B", fontSize: 12 },
      axisTick: { show: false },
    },
    series: [
      {
        type: "bar",
        data: durations,
        barWidth: 16,
        itemStyle: {
          borderRadius: [0, 4, 4, 0],
          color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
            { offset: 0, color: "#C4B5FD" },
            { offset: 1, color: "#7C5CFC" },
          ]),
        },
        label: { show: true, position: "right", color: "#71717A", fontSize: 11, formatter: "{c} ms" },
      },
    ],
  });
};

// ---- 4. 知识库处理状态（环形图）----
const renderKnowledgeChart = () => {
  if (!chartRefs.knowledge.value || !knowledgeStatus.value) return;
  charts.knowledge?.dispose();
  charts.knowledge = echarts.init(chartRefs.knowledge.value);

  const s = knowledgeStatus.value;
  const statusList: Array<[string, number, string]> = [
    ["已完成", s.completed, "#2BA471"],
    ["处理中", s.processing, "#7C5CFC"],
    ["失败", s.failed, "#D54941"],
    ["待处理", s.uploaded, "#A1A1AA"],
  ];
  const data = statusList
    .map(([name, value, color]) => ({ name, value, itemStyle: { color } }))
    .filter((d) => d.value > 0);

  if (data.length === 0) {
    charts.knowledge.setOption({
      title: { text: "暂无文档", left: "center", top: "center", textStyle: { color: "#A1A1AA", fontSize: 13 } },
    });
    return;
  }

  charts.knowledge.setOption({
    tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
    legend: {
      orient: "vertical",
      right: 8,
      top: "center",
      textStyle: { color: "#71717A", fontSize: 12 },
    },
    series: [
      {
        type: "pie",
        radius: ["48%", "72%"],
        center: ["38%", "50%"],
        itemStyle: { borderRadius: 4, borderColor: "#fff", borderWidth: 2 },
        label: { show: false },
        data,
      },
    ],
  });
};

// ---- 5. 队列状态（柱状图）----
const renderQueueChart = () => {
  if (!chartRefs.queue.value || !queueOverview.value) return;
  charts.queue?.dispose();
  charts.queue = echarts.init(chartRefs.queue.value);

  const labels = ["等待中", "执行中", "已完成", "失败"];
  const values = [queueOverview.value.waiting, queueOverview.value.active, queueOverview.value.completed, queueOverview.value.failed];
  const colors = ["#E37318", "#7C5CFC", "#2BA471", "#D54941"];

  charts.queue.setOption({
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    grid: { top: 16, right: 16, bottom: 24, left: 40 },
    xAxis: {
      type: "category",
      data: labels,
      axisLine: { lineStyle: { color: "#E8EAF0" } },
      axisLabel: { color: "#71717A", fontSize: 11 },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      splitLine: { lineStyle: { color: "#F4F4F5" } },
      axisLabel: { color: "#A1A1AA", fontSize: 11 },
    },
    series: [
      {
        type: "bar",
        data: values.map((v, i) => ({
          value: v,
          itemStyle: { color: colors[i], borderRadius: [4, 4, 0, 0] },
        })),
        barWidth: 32,
      },
    ],
  });
};

// ===========================================================================
// 工具函数
// ===========================================================================
const formatNumber = (n: number): string => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
};

const formatDuration = (ms: number): string => {
  if (!ms) return "-";
  if (ms < 1000) return ms + " ms";
  return (ms / 1000).toFixed(1) + " s";
};

const formatRelativeTime = (dateStr: string): string => {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  if (diffHr < 24) return `${diffHr} 小时前`;
  if (diffDay < 7) return `${diffDay} 天前`;
  return new Date(dateStr).toLocaleDateString("zh-CN");
};

const statusLabelMap: Record<string, string> = {
  COMPLETED: "已完成", FAILED: "失败", RUNNING: "运行中", QUEUED: "排队中",
  PROCESSING: "处理中", UPLOADED: "待处理",
};

const statusBadgeClass = (s: string): string => {
  const m: Record<string, string> = {
    COMPLETED: "badge-success", FAILED: "badge-error", RUNNING: "badge-primary",
    QUEUED: "badge-warning", PROCESSING: "badge-primary", UPLOADED: "badge-default",
  };
  return m[s] || "badge-default";
};

// ===========================================================================
// 计算属性
// ===========================================================================
const failedRuns = computed(() => recentActivities.value?.workflowRuns.filter((r) => r.status === "FAILED") ?? []);
const failedDocs = computed(() => recentActivities.value?.documents.filter((d) => d.status === "FAILED") ?? []);

// ===========================================================================
// 生命周期
// ===========================================================================
onMounted(async () => {
  await loadAll();
  window.addEventListener("resize", handleResize);
});

onBeforeUnmount(() => {
  disposeAllCharts();
  window.removeEventListener("resize", handleResize);
  if (resizeTimer) window.clearTimeout(resizeTimer);
});
</script>

<!-- ======================================================================
     Dashboard 页面布局
     顶部：标题 + 时间范围 + 刷新
     第一行：5 张核心指标卡片
     第二行：执行趋势（宽） + 运行状态（窄）
     第三行：节点耗时 + 知识库状态 + 队列监控
     第四行：最近运行记录（左） + 异常与失败（右，带红色左边框）
     底部：资源汇总 + 更新时间
====================================================================== -->
<template>
  <div class="dashboard">
    <!-- ========== 页面标题栏 ========== -->
    <header class="page-header">
      <div class="header-left">
        <h1 class="page-title">控制台</h1>
        <p class="page-subtitle">工作空间与 AI 运行情况总览</p>
      </div>
      <div class="header-right">
        <div class="time-range-select">
          <span class="range-label">时间范围</span>
          <div class="range-buttons">
            <button
              v-for="range in ['7', '14', '30']"
              :key="range"
              class="range-btn"
              :class="{ active: timeRange === range }"
              @click="timeRange = range as '7' | '14' | '30'; handleTimeRangeChange()"
            >
              近 {{ range }} 天
            </button>
          </div>
        </div>
        <button class="refresh-btn" :disabled="refreshing" @click="handleRefresh">
          <t-icon :name="refreshing ? 'loading' : 'refresh'" />
          <span>{{ refreshing ? "刷新中..." : "刷新" }}</span>
        </button>
      </div>
    </header>

    <!-- ========== 加载骨架 ========== -->
    <div v-if="loading" class="loading-state">
      <div class="skeleton-cards">
        <div v-for="i in 5" :key="i" class="skeleton-card" />
      </div>
    </div>

    <!-- ========== 错误态 ========== -->
    <div v-else-if="errorMessage" class="error-state">
      <t-icon name="error-circle" />
      <p>{{ errorMessage }}</p>
      <t-button theme="primary" @click="loadAll">重新加载</t-button>
    </div>

    <template v-else>
      <!-- ========== 1. 核心指标卡片 ========== -->
      <section class="metrics-row">
        <div class="metric-card metric-purple">
          <div class="metric-icon"><t-icon name="component-space" /></div>
          <div class="metric-body">
            <div class="metric-value">{{ overview?.workflows.total ?? 0 }}</div>
            <div class="metric-label">工作流总数</div>
            <div class="metric-sub">已发布 {{ overview?.workflows.published ?? 0 }}</div>
          </div>
        </div>
        <div class="metric-card metric-blue">
          <div class="metric-icon"><t-icon name="play-circle" /></div>
          <div class="metric-body">
            <div class="metric-value">{{ overview?.workflows.runCount ?? 0 }}</div>
            <div class="metric-label">运行次数</div>
            <div class="metric-sub">近 {{ overview?.periodDays ?? 7 }} 天</div>
          </div>
        </div>
        <div class="metric-card metric-green">
          <div class="metric-icon"><t-icon name="check-circle" /></div>
          <div class="metric-body">
            <div class="metric-value">{{ overview?.workflows.successRate ?? 0 }}%</div>
            <div class="metric-label">成功率</div>
            <div class="metric-sub">失败 {{ overview?.workflows.runFailed ?? 0 }} · 平均 {{ formatDuration(overview?.workflows.avgDurationMs ?? 0) }}</div>
          </div>
        </div>
        <div class="metric-card metric-orange">
          <div class="metric-icon"><t-icon name="data" /></div>
          <div class="metric-body">
            <div class="metric-value">{{ overview?.knowledgeBases.documents ?? 0 }}</div>
            <div class="metric-label">知识库文档</div>
            <div class="metric-sub">共 {{ overview?.knowledgeBases.total ?? 0 }} 个知识库</div>
          </div>
        </div>
        <div class="metric-card metric-pink">
          <div class="metric-icon"><t-icon name="server" /></div>
          <div class="metric-body">
            <div class="metric-value">{{ formatNumber(overview?.tokenUsage ?? 0) }}</div>
            <div class="metric-label">Token 消耗</div>
            <div class="metric-sub">待接入模型调用日志</div>
          </div>
        </div>
      </section>

      <!-- ========== 2. 执行趋势 + 状态分布 ========== -->
      <section class="charts-row">
        <div class="chart-card chart-wide">
          <div class="chart-header">
            <h3 class="chart-title">工作流执行趋势</h3>
            <span class="chart-desc">近 {{ overview?.periodDays ?? 7 }} 天执行量与成功量</span>
          </div>
          <div ref="chartRefs.trend" class="chart-body" />
        </div>
        <div class="chart-card">
          <div class="chart-header">
            <h3 class="chart-title">运行结果分布</h3>
            <span class="chart-desc">近 {{ overview?.periodDays ?? 7 }} 天</span>
          </div>
          <div ref="chartRefs.status" class="chart-body" />
        </div>
      </section>

      <!-- ========== 3. Phase 2: 节点 + 知识库 + 队列 ========== -->
      <section class="charts-row charts-row-triple">
        <div class="chart-card">
          <div class="chart-header">
            <h3 class="chart-title">节点平均耗时</h3>
            <span class="chart-desc">TOP {{ nodePerformance.length }}</span>
          </div>
          <div ref="chartRefs.node" class="chart-body chart-body-sm" />
        </div>
        <div class="chart-card">
          <div class="chart-header">
            <h3 class="chart-title">文档处理状态</h3>
            <span class="chart-desc">完成率 {{ knowledgeStatus?.completionRate ?? 0 }}%</span>
          </div>
          <div ref="chartRefs.knowledge" class="chart-body" />
        </div>
        <div class="chart-card">
          <div class="chart-header">
            <h3 class="chart-title">异步任务队列</h3>
            <span class="chart-desc">最近 24 小时</span>
          </div>
          <div ref="chartRefs.queue" class="chart-body" />
        </div>
      </section>

      <!-- ========== 4. 最近运行记录 + 异常 ========== -->
      <section class="bottom-row">
        <div class="activity-card">
          <div class="activity-header">
            <h3 class="chart-title">最近运行记录</h3>
          </div>
          <div class="activity-list">
            <template v-if="recentActivities?.workflowRuns && recentActivities.workflowRuns.length > 0">
              <div v-for="run in recentActivities.workflowRuns" :key="run.id" class="activity-item">
                <div class="activity-info">
                  <span class="activity-name">{{ run.workflowName }}</span>
                  <span class="activity-time">{{ formatRelativeTime(run.createdAt) }}</span>
                </div>
                <span class="status-badge" :class="statusBadgeClass(run.status)">
                  {{ statusLabelMap[run.status] || run.status }}
                </span>
              </div>
            </template>
            <div v-else class="empty-state">
              <t-icon name="chat" />
              <p>暂无运行记录</p>
            </div>
          </div>
        </div>

        <div class="activity-card activity-error">
          <div class="activity-header">
            <h3 class="chart-title">异常与失败</h3>
            <div class="error-count" v-if="failedRuns.length + failedDocs.length > 0">
              {{ failedRuns.length + failedDocs.length }} 个问题
            </div>
          </div>
          <div class="activity-list">
            <template v-if="failedRuns.length > 0">
              <div v-for="run in failedRuns" :key="run.id" class="activity-item error-item">
                <t-icon name="error-circle" class="error-icon" />
                <div class="activity-info">
                  <span class="activity-name">{{ run.workflowName }}</span>
                  <span class="activity-desc">{{ run.errorMessage || "工作流执行失败" }}</span>
                </div>
                <span class="activity-time">{{ formatRelativeTime(run.createdAt) }}</span>
              </div>
            </template>
            <template v-if="failedDocs.length > 0">
              <div v-for="doc in failedDocs" :key="doc.id" class="activity-item error-item">
                <t-icon name="file" class="error-icon" />
                <div class="activity-info">
                  <span class="activity-name">{{ doc.fileName }}</span>
                  <span class="activity-desc">{{ doc.errorMessage || "文档处理失败" }}</span>
                </div>
                <span class="activity-time">{{ formatRelativeTime(doc.updatedAt) }}</span>
              </div>
            </template>
            <div v-if="failedRuns.length === 0 && failedDocs.length === 0" class="empty-state">
              <t-icon name="check-circle" />
              <p>一切正常，没有异常</p>
            </div>
          </div>
        </div>
      </section>

      <!-- ========== 5. 资源汇总 ========== -->
      <section class="resource-summary">
        <div class="resource-item"><t-icon name="chat" /><span class="res-label">Agent</span><span class="res-value">{{ overview?.agents.total ?? 0 }}</span></div>
        <div class="resource-item"><t-icon name="code" /><span class="res-label">Skill</span><span class="res-value">{{ overview?.skills.total ?? 0 }}</span></div>
        <div class="resource-item"><t-icon name="link" /><span class="res-label">MCP</span><span class="res-value">{{ overview?.mcpServers.total ?? 0 }}</span></div>
        <div class="resource-item"><t-icon name="user" /><span class="res-label">已发布工作流</span><span class="res-value">{{ overview?.workflows.published ?? 0 }}</span></div>
        <div class="resource-item"><t-icon name="usergroup" /><span class="res-label">文档总数</span><span class="res-value">{{ knowledgeStatus?.total ?? 0 }}</span></div>
      </section>

      <footer class="dashboard-footer" v-if="lastUpdated">
        数据更新于 {{ lastUpdated.toLocaleTimeString("zh-CN") }}
      </footer>
    </template>
  </div>
</template>

<style scoped lang="less">
@import "../../styles/variables.less";

.dashboard {
  padding: @space-6 @space-8;
  max-width: 1440px;
  margin: 0 auto;
}

/* ==================== 页面标题栏 ==================== */
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: @space-6;

  .header-left {
    .page-title { font-size: @font-hero; font-weight: 600; color: @color-text; margin: 0 0 @space-1; }
    .page-subtitle { font-size: @font-sm; color: @color-text-secondary; margin: 0; }
  }
  .header-right {
    display: flex;
    align-items: center;
    gap: @space-3;

    .time-range-select {
      display: flex;
      align-items: center;
      gap: @space-2;
      .range-label { font-size: @font-sm; color: @color-text-secondary; }
      .range-buttons {
        display: flex;
        background: @color-bg-surface;
        border: 1px solid @color-border;
        border-radius: @radius-md;
        padding: 2px;
      }
      .range-btn {
        padding: 4px 12px;
        font-size: @font-xs;
        color: @color-text-secondary;
        background: transparent;
        border: none;
        border-radius: @radius-sm;
        cursor: pointer;
        transition: all @duration-fast;
        &:hover { color: @color-text; }
        &.active { background: @primary-light; color: @primary; font-weight: 500; }
      }
    }

    .refresh-btn {
      display: flex;
      align-items: center;
      gap: @space-1;
      padding: 6px 14px;
      font-size: @font-sm;
      color: @color-text-secondary;
      background: @color-bg-surface;
      border: 1px solid @color-border;
      border-radius: @radius-md;
      cursor: pointer;
      transition: all @duration-fast;
      &:hover:not(:disabled) { color: @primary; border-color: @primary; }
      &:disabled { opacity: 0.6; cursor: not-allowed; }
    }
  }
}

/* ==================== 骨架 / 错误 ==================== */
.loading-state .skeleton-cards {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: @space-4;
  .skeleton-card {
    height: 100px;
    background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%);
    background-size: 200% 100%;
    animation: skeleton-pulse 1.5s infinite;
    border-radius: @radius-card;
  }
}
@keyframes skeleton-pulse {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.error-state {
  text-align: center;
  padding: 60px 0;
  color: @color-error;
  .t-icon { font-size: 48px; margin-bottom: @space-3; }
  p { font-size: @font-md; color: @color-text-secondary; margin-bottom: @space-4; }
}

/* ==================== 指标卡片 ==================== */
.metrics-row {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: @space-4;
  margin-bottom: @space-6;
}
.metric-card {
  background: @color-bg-surface;
  border: 1px solid @color-border;
  border-radius: @radius-card;
  padding: @space-5;
  display: flex;
  align-items: center;
  gap: @space-4;
  box-shadow: @shadow-card;
  transition: box-shadow @duration-normal;
  &:hover { box-shadow: @shadow-float; }

  .metric-icon {
    width: 44px;
    height: 44px;
    border-radius: @radius-lg;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 22px;
    flex-shrink: 0;
  }
  .metric-body {
    flex: 1;
    min-width: 0;
    .metric-value { font-size: @font-hero; font-weight: 700; color: @color-text; line-height: 1.2; }
    .metric-label { font-size: @font-sm; color: @color-text-secondary; margin-top: 2px; }
    .metric-sub { font-size: @font-xs; color: @color-text-tertiary; margin-top: 4px; }
  }

  &.metric-purple .metric-icon { background: @primary-light; color: @primary; }
  &.metric-blue .metric-icon { background: rgba(24, 144, 255, 0.1); color: #1890FF; }
  &.metric-green .metric-icon { background: rgba(43, 164, 113, 0.12); color: @color-success; }
  &.metric-orange .metric-icon { background: rgba(227, 115, 24, 0.12); color: @color-warning; }
  &.metric-pink .metric-icon { background: rgba(235, 47, 150, 0.1); color: #EB2F96; }
}

/* ==================== 图表卡片 ==================== */
.charts-row {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: @space-4;
  margin-bottom: @space-4;

  &.charts-row-triple {
    grid-template-columns: repeat(3, 1fr);
  }
}
.chart-card {
  background: @color-bg-surface;
  border: 1px solid @color-border;
  border-radius: @radius-card;
  padding: @space-5;
  box-shadow: @shadow-card;

  .chart-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: @space-4;
    .chart-title { font-size: @font-lg; font-weight: 600; color: @color-text; margin: 0; }
    .chart-desc { font-size: @font-xs; color: @color-text-tertiary; }
  }
  .chart-body { height: 280px; }
  .chart-body-sm { height: 220px; }
}

/* ==================== 底部活动区 ==================== */
.bottom-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: @space-4;
  margin-bottom: @space-6;
}

.activity-card {
  background: @color-bg-surface;
  border: 1px solid @color-border;
  border-radius: @radius-card;
  padding: @space-5;
  box-shadow: @shadow-card;

  .activity-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: @space-4;
    .chart-title { font-size: @font-lg; font-weight: 600; color: @color-text; margin: 0; }
    .error-count {
      font-size: @font-xs; font-weight: 500; color: @color-error;
      background: rgba(213, 73, 65, 0.1); padding: 2px 8px; border-radius: @radius-pill;
    }
  }

  &.activity-error { border-left: 3px solid @color-error; }

  .activity-list {
    display: flex; flex-direction: column; gap: @space-2;
    max-height: 360px; overflow-y: auto;
  }
  .activity-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: @space-3; background: @color-bg; border-radius: @radius-md;
    transition: background-color @duration-fast;
    &:hover { background: @color-bg-hover; }

    .activity-info {
      flex: 1; min-width: 0; display: flex; flex-direction: column;
      .activity-name {
        font-size: @font-base; color: @color-text; font-weight: 500;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .activity-desc {
        font-size: @font-xs; color: @color-text-tertiary; margin-top: 2px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
    }
    .activity-time { font-size: @font-xs; color: @color-text-tertiary; flex-shrink: 0; margin-left: @space-3; }

    &.error-item { gap: @space-2;
      .error-icon { color: @color-error; font-size: 16px; flex-shrink: 0; }
      .activity-info .activity-name { color: @color-error; }
    }
  }

  .status-badge {
    font-size: @font-xs; font-weight: 500; padding: 2px 10px;
    border-radius: @radius-pill; flex-shrink: 0;
    &.badge-success { background: rgba(43, 164, 113, 0.12); color: @color-success; }
    &.badge-error { background: rgba(213, 73, 65, 0.1); color: @color-error; }
    &.badge-primary { background: @primary-light; color: @primary; }
    &.badge-warning { background: rgba(227, 115, 24, 0.12); color: @color-warning; }
    &.badge-default { background: @color-bg-hover; color: @color-text-secondary; }
  }

  .empty-state {
    text-align: center; padding: @space-8; color: @color-text-tertiary;
    .t-icon { font-size: 32px; margin-bottom: @space-2; opacity: 0.5; }
    p { font-size: @font-sm; margin: 0; }
  }
}

/* ==================== 资源汇总 ==================== */
.resource-summary {
  display: flex; justify-content: space-around;
  background: @color-bg-surface; border: 1px solid @color-border;
  border-radius: @radius-card; padding: @space-4 @space-6;
  box-shadow: @shadow-card;

  .resource-item {
    display: flex; align-items: center; gap: @space-2;
    .t-icon { color: @color-text-tertiary; font-size: 16px; }
    .res-label { font-size: @font-sm; color: @color-text-secondary; }
    .res-value { font-size: @font-md; font-weight: 600; color: @color-text; }
  }
}

.dashboard-footer {
  text-align: right; padding: @space-4 0;
  font-size: @font-xs; color: @color-text-tertiary;
}

/* ==================== 响应式 ==================== */
@media (max-width: 1400px) {
  .metrics-row { grid-template-columns: repeat(3, 1fr); }
}
@media (max-width: 1200px) {
  .metrics-row { grid-template-columns: repeat(2, 1fr); }
  .charts-row, .charts-row-triple { grid-template-columns: 1fr; }
}
@media (max-width: 768px) {
  .dashboard { padding: @space-4; }
  .page-header { flex-direction: column; gap: @space-4; }
  .metrics-row { grid-template-columns: 1fr; }
  .charts-row, .charts-row-triple, .bottom-row { grid-template-columns: 1fr; }
  .resource-summary { flex-direction: column; gap: @space-3; }
}
</style>
