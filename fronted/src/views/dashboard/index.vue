<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, nextTick } from "vue";
import * as echarts from "echarts";
import { MessagePlugin, type TableCol } from "tdesign-vue-next";
import {
  getOverview,
  getWorkflowTrend,
  getWorkflowStatus,
  getNodePerformance,
  getKnowledgeStatus,
  getRecentActivities,
  getQueueOverview,
  getWorkflowRuns,
  getWorkflowRunDetail,
  getModelUsage,
  type DashboardOverview,
  type WorkflowTrendItem,
  type WorkflowStatusMap,
  type NodePerformanceItem,
  type KnowledgeStatus,
  type RecentActivities,
  type QueueOverview,
  type ModelUsage,
  type WorkflowRunItem,
  type WorkflowRunDetail,
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

// 模型调用统计
const modelUsage = ref<ModelUsage | null>(null);

// 运行记录列表（筛选 + 分页）
const runs = ref<WorkflowRunItem[]>([]);
const runsTotal = ref(0);
const runsPage = ref(1);
const runsPageSize = ref(10);
const runStatusFilter = ref("");
const runErrorCodeFilter = ref("");

// 运行详情抽屉
const drawerVisible = ref(false);
const runDetailLoading = ref(false);
const runDetail = ref<WorkflowRunDetail | null>(null);
const detailTab = ref<"overview" | "nodes" | "logs" | "models">("overview");

// ===========================================================================
// ECharts 实例管理
// ===========================================================================
// ⚠️ 图表容器必须用「顶层 ref + ref="xxx"」，不能写成嵌套对象（如 ref="chartRefs.trend"）。
// Vue 的 setRef 处理字符串 ref 时是 `refs[ref] = el; if (hasOwn(setupState, ref)) setupState[ref] = el`，
// 而 setupState 里只有 chartRefs 这个键、没有 "chartRefs.trend" 这个键，于是元素被存进组件内部
// refs["chartRefs.trend"]，chartRefs.trend.value 永远是 undefined → 所有图表容器留空。
const trendChartEl = ref<HTMLDivElement>();
const statusChartEl = ref<HTMLDivElement>();
const nodeChartEl = ref<HTMLDivElement>();
const knowledgeChartEl = ref<HTMLDivElement>();
const queueChartEl = ref<HTMLDivElement>();
const modelTokenChartEl = ref<HTMLDivElement>();

const charts: Record<string, echarts.ECharts | null> = {
  trend: null,
  status: null,
  node: null,
  knowledge: null,
  queue: null,
  modelToken: null,
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

    await Promise.allSettled([loadModelUsage(), loadRuns()]);

    lastUpdated.value = new Date();
  } catch {
    errorMessage.value = "数据加载失败，请稍后重试";
  } finally {
    loading.value = false;
  }

  // ⚠️ 顺序不能改：所有图表容器都在 `v-else`（loading 为 false 才渲染）的分支里，
  // 必须等 loading 关闭、DOM 真正挂载之后再初始化 ECharts。
  // 之前这里是在 finally 之前调用的，此时容器还不存在 → 6 个图表全部空白。
  await nextTick();
  renderAllCharts();
};

const loadModelUsage = async () => {
  try {
    modelUsage.value = await getModelUsage(parseInt(timeRange.value));
  } catch {
    MessagePlugin.warning("模型调用统计加载失败");
  }
};

const loadRuns = async () => {
  try {
    const res = await getWorkflowRuns({
      status: runStatusFilter.value || undefined,
      errorCode: runErrorCodeFilter.value || undefined,
      days: parseInt(timeRange.value),
      page: runsPage.value,
      pageSize: runsPageSize.value,
    });
    runs.value = res.items;
    runsTotal.value = res.total;
  } catch {
    MessagePlugin.warning("运行记录加载失败");
  }
};

const handleRefresh = async () => {
  refreshing.value = true;
  await loadAll();
  refreshing.value = false;
  MessagePlugin.success("数据已刷新");
};

const handleTimeRangeChange = async () => {
  runsPage.value = 1;
  await loadAll();
};

const handleRunsFilterChange = async () => {
  runsPage.value = 1;
  await loadRuns();
};

const handleRunsPageChange = async (page: number) => {
  runsPage.value = page;
  await loadRuns();
};

const handleRunsPageSizeChange = async (size: number) => {
  runsPageSize.value = size;
  runsPage.value = 1;
  await loadRuns();
};

const openRunDetail = async (runId: string) => {
  drawerVisible.value = true;
  runDetailLoading.value = true;
  detailTab.value = "overview";
  runDetail.value = null;
  try {
    runDetail.value = await getWorkflowRunDetail(runId);
  } catch {
    MessagePlugin.error("运行详情加载失败");
  } finally {
    runDetailLoading.value = false;
  }
};

const closeDrawer = () => {
  drawerVisible.value = false;
};

const copyText = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    MessagePlugin.success("已复制到剪贴板");
  } catch {
    MessagePlugin.warning("复制失败，请手动选择");
  }
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
  renderModelTokenChart();
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
  if (!trendChartEl.value || trend.value.length === 0) return;
  charts.trend?.dispose();
  charts.trend = echarts.init(trendChartEl.value);

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
  if (!statusChartEl.value || !statusMap.value) return;
  charts.status?.dispose();
  charts.status = echarts.init(statusChartEl.value);

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
  if (!nodeChartEl.value || nodePerformance.value.length === 0) return;
  charts.node?.dispose();
  charts.node = echarts.init(nodeChartEl.value);

  const sorted = [...nodePerformance.value].sort((a, b) => b.avgDurationMs - a.avgDurationMs);
  const types = sorted.map((n) => `${n.nodeType} (失败${n.failRate}%)`).reverse();
  const durations = sorted.map((n) => n.avgDurationMs).reverse();

  charts.node.setOption({
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    grid: { top: 8, right: 30, bottom: 8, left: 110 },
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
  if (!knowledgeChartEl.value || !knowledgeStatus.value) return;
  charts.knowledge?.dispose();
  charts.knowledge = echarts.init(knowledgeChartEl.value);

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
  if (!queueChartEl.value || !queueOverview.value) return;
  charts.queue?.dispose();
  charts.queue = echarts.init(queueChartEl.value);

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

// ---- 6. 模型 Token 消耗（按模型横向柱状图）----
const renderModelTokenChart = () => {
  if (!modelTokenChartEl.value || !modelUsage.value || modelUsage.value.models.length === 0) return;
  charts.modelToken?.dispose();
  charts.modelToken = echarts.init(modelTokenChartEl.value);

  // 排序：Token 优先；Token 相同（流式调用拿不到 usage 时为 0）时用调用次数兜底，
  // 避免「有调用但 0 Token」的模型被排到最后看不见。
  const sorted = [...modelUsage.value.models]
    .sort((a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls)
    .slice(0, 10);
  const models = sorted.map((m) => m.model).reverse();
  const tokens = sorted.map((m) => m.totalTokens).reverse();
  const rows = sorted.slice().reverse();

  charts.modelToken.setOption({
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      formatter: (params: unknown) => {
        const first = (Array.isArray(params) ? params[0] : params) as
          | { dataIndex?: number }
          | undefined;
        const row = rows[first?.dataIndex ?? 0];
        if (!row) return "";
        return `${row.model}<br/>Token：${formatNumber(row.totalTokens)}<br/>调用：${row.calls} 次<br/>厂商：${row.provider}`;
      },
    },
    grid: { top: 12, right: 44, bottom: 8, left: 110 },
    xAxis: {
      type: "value",
      splitLine: { lineStyle: { color: "#F4F4F5" } },
      axisLabel: { color: "#A1A1AA", fontSize: 11, formatter: (v: number) => formatNumber(v) },
    },
    yAxis: {
      type: "category",
      data: models,
      axisLine: { show: false },
      axisLabel: { color: "#18181B", fontSize: 12 },
      axisTick: { show: false },
    },
    series: [
      {
        type: "bar",
        data: tokens,
        barWidth: 16,
        itemStyle: {
          borderRadius: [0, 4, 4, 0],
          color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
            { offset: 0, color: "#C4B5FD" },
            { offset: 1, color: "#7C5CFC" },
          ]),
        },
        label: { show: true, position: "right", color: "#71717A", fontSize: 11, formatter: (p: { value: number }) => formatNumber(p.value) },
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

const formatDuration = (ms: number | null | undefined): string => {
  if (!ms) return "-";
  if (ms < 1000) return ms + " ms";
  return (ms / 1000).toFixed(1) + " s";
};

const formatRelativeTime = (dateStr: string | null): string => {
  if (!dateStr) return "-";
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

const formatDateTime = (dateStr: string | null): string => {
  if (!dateStr) return "-";
  return new Date(dateStr).toLocaleString("zh-CN");
};

const formatJson = (value: unknown): string => {
  if (value == null) return "-";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const formatCurrency = (n: number | null | undefined): string => {
  if (n == null) return "-";
  return "¥" + n.toFixed(4);
};

const statusLabelMap: Record<string, string> = {
  COMPLETED: "已完成", FAILED: "失败", RUNNING: "运行中", QUEUED: "排队中",
  PROCESSING: "处理中", UPLOADED: "待处理",
};

const triggerLabelMap: Record<string, string> = {
  MANUAL: "手动", SCHEDULE: "定时", API: "API", WEBHOOK: "Webhook",
};

const statusBadgeClass = (s: string): string => {
  const m: Record<string, string> = {
    COMPLETED: "badge-success", FAILED: "badge-error", RUNNING: "badge-primary",
    QUEUED: "badge-warning", PROCESSING: "badge-primary", UPLOADED: "badge-default",
  };
  return m[s] || "badge-default";
};

const runLogLines = computed<string[]>(() => {
  const d = runDetail.value;
  if (!d) return [];
  const lines: string[] = [];
  lines.push(`[${formatDateTime(d.startedAt)}] 运行开始 · 工作流：${d.workflowName}`);
  for (const n of d.nodes) {
    const ts = formatDateTime(n.startedAt);
    const dur = n.durationMs != null ? ` · ${n.durationMs}ms` : "";
    if (n.status === "FAILED") {
      lines.push(`[${ts}] ✗ 节点「${n.label || n.nodeType}」执行失败${dur} · 错误码 ${n.errorCode || "-"} · ${n.errorMessage || ""}`);
    } else {
      lines.push(`[${ts}] ✓ 节点「${n.label || n.nodeType}」执行成功${dur}`);
    }
  }
  lines.push(`[${formatDateTime(d.completedAt)}] 运行结束 · 状态：${statusLabelMap[d.status] || d.status} · 耗时 ${formatDuration(d.durationMs)}`);
  return lines;
});

// ===========================================================================
// t-table 列定义
// ===========================================================================
// 1. 模型明细表格（AI 模型调用监控区域）
const modelDetailColumns: TableCol[] = [
  { colKey: "model", title: "模型", minWidth: 140 },
  { colKey: "provider", title: "厂商", width: 100 },
  { colKey: "calls", title: "调用", width: 80 },
  { colKey: "successRate", title: "成功率", width: 90 },
  { colKey: "totalTokens", title: "Token", width: 100 },
  { colKey: "avgLatencyMs", title: "延迟", width: 90 },
  { colKey: "estimatedCost", title: "费用", width: 100 },
];

// 2. 运行记录表格（工作流运行记录区域，带分页）
const runsColumns: TableCol[] = [
  { colKey: "workflowName", title: "工作流", minWidth: 140 },
  { colKey: "status", title: "状态", width: 90 },
  { colKey: "triggerType", title: "触发", width: 70 },
  { colKey: "failedNode", title: "失败节点", minWidth: 150 },
  { colKey: "durationMs", title: "耗时", width: 90 },
  { colKey: "startedAt", title: "开始时间", width: 130 },
  { colKey: "action", title: "操作", width: 100, align: "right" },
];

// 3. 运行详情 - 模型调用表格（抽屉内 Tab 4）
const runModelCallsColumns: TableCol[] = [
  { colKey: "model", title: "模型", minWidth: 160 },
  { colKey: "callType", title: "类型", width: 80 },
  { colKey: "totalTokens", title: "Token", width: 100 },
  { colKey: "latencyMs", title: "延迟", width: 90 },
  { colKey: "status", title: "状态", width: 90 },
  { colKey: "estimatedCost", title: "费用", width: 100 },
];

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
     Dashboard 页面布局（AI 工作流运行监控与平台运营控制台）
     顶部：标题 + 时间范围 + 刷新
     第一行：8 张核心指标卡片（含运行中 / P95 / 24h失败 / 真实Token）
     第二行：执行趋势（宽） + 运行状态（窄）
     第三行：节点耗时 + 知识库状态 + 队列监控
     第四行：模型调用监控（Token / 延迟 / 费用 + 按模型分布）
     第五行：运行记录（筛选 + 分页） —— 点击打开运行详情抽屉（4 Tab）
     第六行：最近运行记录（左） + 异常与失败（右，带红色左边框）
     底部：资源汇总 + 更新时间
====================================================================== -->
<template>
  <div class="dashboard">
    <!-- ========== 页面标题栏 ========== -->
    <header class="page-header">
      <div class="header-left">
        <h1 class="page-title">AI 工作流运行监控</h1>
        <p class="page-subtitle">工作空间与 AI 运行情况总览</p>
      </div>
      <div class="header-right">
        <div class="time-range-select">
          <span class="range-label">时间范围</span>
          <div class="range-buttons">
            <button v-for="range in ['7', '14', '30']" :key="range" class="range-btn"
              :class="{ active: timeRange === range }"
              @click="timeRange = range as '7' | '14' | '30'; handleTimeRangeChange()">
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
        <div v-for="i in 8" :key="i" class="skeleton-card" />
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
            <div class="metric-value">{{ overview?.workflows.running ?? 0 }}</div>
            <div class="metric-label">运行中</div>
            <div class="metric-sub">排队 {{ overview?.workflows.runQueued ?? 0 }}</div>
          </div>
        </div>
        <div class="metric-card metric-blue">
          <div class="metric-icon"><t-icon name="time" /></div>
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
            <div class="metric-sub">失败 {{ overview?.workflows.runFailed ?? 0 }} · 平均 {{
              formatDuration(overview?.workflows.avgDurationMs ?? 0) }}</div>
          </div>
        </div>
        <div class="metric-card metric-orange">
          <div class="metric-icon"><t-icon name="chart" /></div>
          <div class="metric-body">
            <div class="metric-value">{{ formatDuration(overview?.workflows.p95DurationMs ?? 0) }}</div>
            <div class="metric-label">P95 耗时</div>
            <div class="metric-sub">近 {{ overview?.periodDays ?? 7 }} 天</div>
          </div>
        </div>
        <div class="metric-card metric-pink">
          <div class="metric-icon"><t-icon name="error-circle" /></div>
          <div class="metric-body">
            <div class="metric-value">{{ overview?.workflows.failedLast24h ?? 0 }}</div>
            <div class="metric-label">24h 失败</div>
            <div class="metric-sub">需重点关注</div>
          </div>
        </div>
        <div class="metric-card metric-pink">
          <div class="metric-icon"><t-icon name="data" /></div>
          <div class="metric-body">
            <div class="metric-value">{{ formatNumber(overview?.tokenUsage ?? 0) }}</div>
            <div class="metric-label">真实 Token 消耗</div>
            <div class="metric-sub">来自模型调用日志</div>
          </div>
        </div>
        <div class="metric-card metric-purple">
          <div class="metric-icon"><t-icon name="server" /></div>
          <div class="metric-body">
            <div class="metric-value">{{ formatNumber(overview?.modelCalls ?? 0) }}</div>
            <div class="metric-label">模型调用数</div>
            <div class="metric-sub">近 {{ overview?.periodDays ?? 7 }} 天</div>
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
          <div ref="trendChartEl" class="chart-body" />
        </div>
        <div class="chart-card">
          <div class="chart-header">
            <h3 class="chart-title">运行结果分布</h3>
            <span class="chart-desc">近 {{ overview?.periodDays ?? 7 }} 天</span>
          </div>
          <div ref="statusChartEl" class="chart-body" />
        </div>
      </section>

      <!-- ========== 3. 节点 + 知识库 + 队列 ========== -->
      <section class="charts-row charts-row-triple">
        <div class="chart-card">
          <div class="chart-header">
            <h3 class="chart-title">节点平均耗时</h3>
            <span class="chart-desc">TOP {{ nodePerformance.length }}（含失败率）</span>
          </div>
          <div ref="nodeChartEl" class="chart-body chart-body-sm" />
        </div>
        <div class="chart-card">
          <div class="chart-header">
            <h3 class="chart-title">文档处理状态</h3>
            <span class="chart-desc">完成率 {{ knowledgeStatus?.completionRate ?? 0 }}%</span>
          </div>
          <div ref="knowledgeChartEl" class="chart-body" />
        </div>
        <div class="chart-card">
          <div class="chart-header">
            <h3 class="chart-title">异步任务队列</h3>
            <span class="chart-desc">最近 24 小时</span>
          </div>
          <div ref="queueChartEl" class="chart-body" />
        </div>
      </section>

      <!-- ========== 4. AI 模型调用监控 ========== -->
      <section class="model-usage">
        <div class="section-title">
          <h2>AI 模型调用监控</h2>
          <span class="section-desc">Token / 延迟 / 费用 · 近 {{ modelUsage?.periodDays ?? overview?.periodDays ?? 7 }}
            天</span>
        </div>
        <div class="model-stat-row" v-if="modelUsage">
          <div class="model-stat">
            <div class="model-stat-value">{{ formatNumber(modelUsage.total.calls) }}</div>
            <div class="model-stat-label">总调用</div>
          </div>
          <div class="model-stat">
            <div class="model-stat-value">{{ modelUsage.total.successRate }}%</div>
            <div class="model-stat-label">成功率</div>
          </div>
          <div class="model-stat">
            <div class="model-stat-value">{{ formatDuration(modelUsage.total.avgLatencyMs) }}</div>
            <div class="model-stat-label">平均延迟</div>
          </div>
          <div class="model-stat">
            <div class="model-stat-value">{{ formatNumber(modelUsage.total.totalTokens) }}</div>
            <div class="model-stat-label">Token 总量</div>
          </div>
          <div class="model-stat">
            <div class="model-stat-value">{{ formatCurrency(modelUsage.total.estimatedCost) }}</div>
            <div class="model-stat-label">估算费用</div>
          </div>
        </div>
        <div class="model-detail">
          <div class="chart-card model-chart">
            <div class="chart-header">
              <h3 class="chart-title">各模型 Token 消耗</h3>
              <span class="chart-desc">TOP 10（含调用次数）</span>
            </div>
            <div ref="modelTokenChartEl" class="chart-body chart-body-sm" />
          </div>
          <div class="chart-card model-table">
            <div class="chart-header">
              <h3 class="chart-title">模型明细</h3>
            </div>
            <div class="model-table-body">
              <t-table v-if="modelUsage && modelUsage.models.length > 0" :data="modelUsage.models"
                :columns="modelDetailColumns" row-key="model" size="small" hover :pagination="null">
                <template #successRate="{ row }">
                  <span class="status-badge"
                    :class="row.successRate >= 99 ? 'badge-success' : row.successRate >= 90 ? 'badge-warning' : 'badge-error'">
                    {{ row.successRate }}%
                  </span>
                </template>
                <template #totalTokens="{ row }">{{ formatNumber(row.totalTokens) }}</template>
                <template #avgLatencyMs="{ row }">{{ formatDuration(row.avgLatencyMs) }}</template>
                <template #estimatedCost="{ row }">{{ formatCurrency(row.estimatedCost) }}</template>
              </t-table>
              <div v-else class="empty-state">
                <t-icon name="data" />
                <p>暂无模型调用记录</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- ========== 5. 运行记录（筛选 + 分页 + 详情） ========== -->
      <section class="runs-section">
        <div class="section-title">
          <h2>工作流运行记录</h2>
          <span class="section-desc">失败节点 / 错误码 / 重试 · 共 {{ runsTotal }} 条</span>
        </div>
        <div class="runs-filter">
          <div class="filter-item">
            <span class="filter-label">状态</span>
            <select v-model="runStatusFilter" class="filter-select" @change="handleRunsFilterChange">
              <option value="">全部</option>
              <option value="COMPLETED">已完成</option>
              <option value="FAILED">失败</option>
              <option value="RUNNING">运行中</option>
              <option value="QUEUED">排队中</option>
            </select>
          </div>
          <div class="filter-item">
            <span class="filter-label">错误码</span>
            <input v-model="runErrorCodeFilter" class="filter-input" placeholder="如 AI_PROVIDER_TIMEOUT"
              @keyup.enter="handleRunsFilterChange" />
          </div>
          <button class="filter-btn" @click="handleRunsFilterChange">筛选</button>
          <button class="filter-btn ghost"
            @click="runStatusFilter = ''; runErrorCodeFilter = ''; handleRunsFilterChange()">重置</button>
        </div>

        <t-table :data="runs" :columns="runsColumns" row-key="id" size="small" hover :loading="loading" :pagination="{
          current: runsPage,
          pageSize: runsPageSize,
          total: runsTotal,
          showJumper: true,
          showPageSize: true,
          pageSizeOptions: [10, 20, 50],
          onCurrentChange: handleRunsPageChange,
          onPageSizeChange: handleRunsPageSizeChange,
        }">
          <template #workflowName="{ row }"><span class="run-name">{{ row.workflowName }}</span></template>
          <template #status="{ row }">
            <span class="status-badge" :class="statusBadgeClass(row.status)">
              {{ statusLabelMap[row.status] || row.status }}
            </span>
          </template>
          <template #triggerType="{ row }">{{ triggerLabelMap[row.triggerType] || row.triggerType }}</template>
          <template #failedNode="{ row }">
            <span v-if="row.failedNode" class="failed-node" :title="row.failedNodeError || ''">
              {{ row.failedNode }}<small v-if="row.errorCode"> · {{ row.errorCode }}</small>
            </span>
            <span v-else class="muted">-</span>
          </template>
          <template #durationMs="{ row }">{{ formatDuration(row.durationMs) }}</template>
          <template #startedAt="{ row }"><span class="muted">{{ formatRelativeTime(row.startedAt) }}</span></template>
          <template #action="{ row }">
            <t-button theme="primary" variant="text" size="small" @click="openRunDetail(row.id)">查看详情</t-button>
          </template>
        </t-table>
        <div v-if="runs.length === 0 && !loading" class="empty-state">
          <t-icon name="history" />
          <p>暂无运行记录</p>
        </div>
      </section>

      <!-- ========== 6. 最近运行记录 + 异常 ========== -->
      <section class="bottom-row">
        <div class="activity-card">
          <div class="activity-header">
            <h3 class="chart-title">最近运行记录</h3>
          </div>
          <div class="activity-list">
            <template v-if="recentActivities?.workflowRuns && recentActivities.workflowRuns.length > 0">
              <div v-for="run in recentActivities.workflowRuns" :key="run.id" class="activity-item clickable"
                @click="openRunDetail(run.id)">
                <div class="activity-info">
                  <span class="activity-name">{{ run.workflowName }}</span>
                  <span class="activity-time">{{ formatRelativeTime(run.createdAt) }} · {{
                    formatDuration(run.durationMs) }}</span>
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
              <div v-for="run in failedRuns" :key="run.id" class="activity-item error-item clickable"
                @click="openRunDetail(run.id)">
                <t-icon name="error-circle" class="error-icon" />
                <div class="activity-info">
                  <span class="activity-name">{{ run.workflowName }}</span>
                  <span class="activity-desc">{{ run.errorCode ? `[${run.errorCode}] ` : '' }}{{ run.errorMessage ||
                    "工作流执行失败" }}</span>
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

      <!-- ========== 7. 资源汇总 ========== -->
      <section class="resource-summary">
        <div class="resource-item"><t-icon name="chat" /><span class="res-label">Agent</span><span class="res-value">{{
          overview?.agents.total ?? 0 }}</span></div>
        <div class="resource-item"><t-icon name="code" /><span class="res-label">Skill</span><span class="res-value">{{
          overview?.skills.total ?? 0 }}</span></div>
        <div class="resource-item"><t-icon name="link" /><span class="res-label">MCP</span><span class="res-value">{{
          overview?.mcpServers.total ?? 0 }}</span></div>
        <div class="resource-item"><t-icon name="user" /><span class="res-label">已发布工作流</span><span class="res-value">{{
          overview?.workflows.published ?? 0 }}</span></div>
        <div class="resource-item"><t-icon name="usergroup" /><span class="res-label">文档总数</span><span
            class="res-value">{{
              knowledgeStatus?.total ?? 0 }}</span></div>
      </section>

      <footer class="dashboard-footer" v-if="lastUpdated">
        数据更新于 {{ lastUpdated.toLocaleTimeString("zh-CN") }}
      </footer>
    </template>

    <!-- ========== 运行详情抽屉 ========== -->
    <div v-if="drawerVisible" class="run-drawer-mask" @click="closeDrawer">
      <div class="run-drawer" @click.stop>
        <div class="drawer-header">
          <div class="drawer-title">
            <span>运行详情</span>
            <span class="drawer-sub">{{ runDetail?.workflowName }} · {{ runDetail?.id.slice(0, 8) }}</span>
          </div>
          <button class="drawer-close" @click="closeDrawer"><t-icon name="close" /></button>
        </div>

        <div v-if="runDetailLoading" class="drawer-loading">
          <t-icon name="loading" spin />
          <p>加载中...</p>
        </div>

        <template v-else-if="runDetail">
          <div class="drawer-tabs">
            <button class="detail-tab" :class="{ active: detailTab === 'overview' }"
              @click="detailTab = 'overview'">执行概览</button>
            <button class="detail-tab" :class="{ active: detailTab === 'nodes' }"
              @click="detailTab = 'nodes'">节点追踪</button>
            <button class="detail-tab" :class="{ active: detailTab === 'logs' }"
              @click="detailTab = 'logs'">执行日志</button>
            <button class="detail-tab" :class="{ active: detailTab === 'models' }"
              @click="detailTab = 'models'">模型调用</button>
          </div>

          <div class="drawer-body">
            <!-- Tab 1: 执行概览 -->
            <div v-show="detailTab === 'overview'" class="detail-pane">
              <div class="kv-grid">
                <div class="kv"><span class="kv-k">状态</span><span class="kv-v"><span class="status-badge"
                      :class="statusBadgeClass(runDetail.status)">{{ statusLabelMap[runDetail.status] ||
                        runDetail.status }}</span></span></div>
                <div class="kv"><span class="kv-k">触发方式</span><span class="kv-v">{{
                  triggerLabelMap[runDetail.triggerType] || runDetail.triggerType }}</span></div>
                <div class="kv"><span class="kv-k">错误码</span><span class="kv-v">{{ runDetail.errorCode || "-" }}</span>
                </div>
                <div class="kv"><span class="kv-k">总耗时</span><span class="kv-v">{{ formatDuration(runDetail.durationMs)
                }}</span></div>
                <div class="kv"><span class="kv-k">开始时间</span><span class="kv-v">{{ formatDateTime(runDetail.startedAt)
                }}</span></div>
                <div class="kv"><span class="kv-k">结束时间</span><span class="kv-v">{{
                  formatDateTime(runDetail.completedAt) }}</span></div>
              </div>
              <div v-if="runDetail.errorMessage" class="error-box">
                <div class="error-box-head">
                  <span>错误信息</span>
                  <button class="link-btn" @click="copyText(runDetail.errorMessage || '')">复制</button>
                </div>
                <pre class="error-pre">{{ runDetail.errorMessage }}</pre>
              </div>
              <div class="io-block">
                <div class="io-head"><span>输入（已脱敏）</span><button class="link-btn"
                    @click="copyText(formatJson(runDetail.input))">复制</button></div>
                <pre class="io-pre">{{ formatJson(runDetail.input) }}</pre>
              </div>
              <div class="io-block">
                <div class="io-head"><span>输出（已脱敏）</span><button class="link-btn"
                    @click="copyText(formatJson(runDetail.output))">复制</button></div>
                <pre class="io-pre">{{ formatJson(runDetail.output) }}</pre>
              </div>
            </div>

            <!-- Tab 2: 节点追踪 -->
            <div v-show="detailTab === 'nodes'" class="detail-pane">
              <div v-for="node in runDetail.nodes" :key="node.id" class="node-trace"
                :class="{ 'node-failed': node.status === 'FAILED' }">
                <div class="node-trace-head">
                  <span class="node-idx">{{ node.nodeType }}</span>
                  <span class="node-label">{{ node.label || "未命名节点" }}</span>
                  <span class="status-badge" :class="statusBadgeClass(node.status)">{{ statusLabelMap[node.status] ||
                    node.status }}</span>
                  <span class="node-dur">{{ formatDuration(node.durationMs) }}</span>
                </div>
                <div class="node-meta" v-if="node.attemptsMade || node.errorCode">
                  重试 {{ node.attemptsMade }} 次<span v-if="node.errorCode"> · 错误码 {{ node.errorCode }}</span>
                </div>
                <div v-if="node.errorMessage" class="node-error">{{ node.errorMessage }}</div>
                <details class="node-io">
                  <summary>输入 / 输出</summary>
                  <pre class="io-pre">{{ formatJson(node.input) }}</pre>
                  <pre class="io-pre">{{ formatJson(node.output) }}</pre>
                </details>
              </div>
            </div>

            <!-- Tab 3: 执行日志 -->
            <div v-show="detailTab === 'logs'" class="detail-pane">
              <pre class="log-pre">{{ runLogLines.join("\n") }}</pre>
            </div>

            <!-- Tab 4: 模型调用 -->
            <div v-show="detailTab === 'models'" class="detail-pane">
              <t-table v-if="runDetail.modelCalls.length > 0" :data="runDetail.modelCalls"
                :columns="runModelCallsColumns" row-key="id" size="small" hover :pagination="null">
                <template #model="{ row }">{{ row.model }}<small class="muted"> · {{ row.provider }}</small></template>
                <template #totalTokens="{ row }">{{ formatNumber(row.totalTokens) }}</template>
                <template #latencyMs="{ row }">{{ formatDuration(row.latencyMs) }}</template>
                <template #status="{ row }">
                  <span class="status-badge" :class="row.status === 'SUCCESS' ? 'badge-success' : 'badge-error'">{{
                    row.status }}</span>
                </template>
                <template #estimatedCost="{ row }">{{ formatCurrency(row.estimatedCost) }}</template>
              </t-table>
              <div v-else class="empty-state">
                <t-icon name="data" />
                <p>本次运行无模型调用记录</p>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>
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
    .page-title {
      font-size: @font-hero;
      font-weight: 600;
      color: @color-text;
      margin: 0 0 @space-1;
    }

    .page-subtitle {
      font-size: @font-sm;
      color: @color-text-secondary;
      margin: 0;
    }
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: @space-3;

    .time-range-select {
      display: flex;
      align-items: center;
      gap: @space-2;

      .range-label {
        font-size: @font-sm;
        color: @color-text-secondary;
      }

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

        &:hover {
          color: @color-text;
        }

        &.active {
          background: @primary-light;
          color: @primary;
          font-weight: 500;
        }
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

      &:hover:not(:disabled) {
        color: @primary;
        border-color: @primary;
      }

      &:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
    }
  }
}

/* ==================== 骨架 / 错误 ==================== */
.loading-state .skeleton-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
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
  0% {
    background-position: 200% 0;
  }

  100% {
    background-position: -200% 0;
  }
}

.error-state {
  text-align: center;
  padding: 60px 0;
  color: @color-error;

  .t-icon {
    font-size: 48px;
    margin-bottom: @space-3;
  }

  p {
    font-size: @font-md;
    color: @color-text-secondary;
    margin-bottom: @space-4;
  }
}

/* ==================== 指标卡片 ==================== */
.metrics-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
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

  &:hover {
    box-shadow: @shadow-float;
  }

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

    .metric-value {
      font-size: @font-hero;
      font-weight: 700;
      color: @color-text;
      line-height: 1.2;
    }

    .metric-label {
      font-size: @font-sm;
      color: @color-text-secondary;
      margin-top: 2px;
    }

    .metric-sub {
      font-size: @font-xs;
      color: @color-text-tertiary;
      margin-top: 4px;
    }
  }

  &.metric-purple .metric-icon {
    background: @primary-light;
    color: @primary;
  }

  &.metric-blue .metric-icon {
    background: rgba(24, 144, 255, 0.1);
    color: #1890FF;
  }

  &.metric-green .metric-icon {
    background: rgba(43, 164, 113, 0.12);
    color: @color-success;
  }

  &.metric-orange .metric-icon {
    background: rgba(227, 115, 24, 0.12);
    color: @color-warning;
  }

  &.metric-pink .metric-icon {
    background: rgba(235, 47, 150, 0.1);
    color: #EB2F96;
  }
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

    .chart-title {
      font-size: @font-lg;
      font-weight: 600;
      color: @color-text;
      margin: 0;
    }

    .chart-desc {
      font-size: @font-xs;
      color: @color-text-tertiary;
    }
  }

  .chart-body {
    height: 280px;
  }

  .chart-body-sm {
    height: 220px;
  }
}

/* ==================== 区块标题 ==================== */
.section-title {
  display: flex;
  align-items: baseline;
  gap: @space-3;
  margin: @space-6 0 @space-4;

  h2 {
    font-size: @font-xl;
    font-weight: 600;
    color: @color-text;
    margin: 0;
  }

  .section-desc {
    font-size: @font-xs;
    color: @color-text-tertiary;
  }
}

/* ==================== 模型调用监控 ==================== */
.model-stat-row {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: @space-4;
  margin-bottom: @space-4;

  .model-stat {
    background: @color-bg-surface;
    border: 1px solid @color-border;
    border-radius: @radius-card;
    padding: @space-4;
    text-align: center;
    box-shadow: @shadow-card;

    .model-stat-value {
      font-size: @font-xl;
      font-weight: 700;
      color: @primary;
    }

    .model-stat-label {
      font-size: @font-xs;
      color: @color-text-secondary;
      margin-top: 4px;
    }
  }
}

.model-detail {
  display: grid;
  grid-template-columns: 1fr 1.4fr;
  gap: @space-4;

  .model-table {
    display: flex;
    flex-direction: column;

    .model-table-body {
      flex: 1;
      overflow: auto;
      max-height: 260px;
    }
  }
}

/* ==================== 运行记录 ==================== */
.runs-section {
  margin-bottom: @space-6;
}

.runs-filter {
  display: flex;
  align-items: center;
  gap: @space-3;
  background: @color-bg-surface;
  border: 1px solid @color-border;
  border-radius: @radius-card;
  padding: @space-3 @space-4;
  margin-bottom: @space-3;
  flex-wrap: wrap;

  .filter-item {
    display: flex;
    align-items: center;
    gap: @space-2;
  }

  .filter-label {
    font-size: @font-sm;
    color: @color-text-secondary;
  }

  .filter-select,
  .filter-input {
    padding: 6px 10px;
    font-size: @font-sm;
    border: 1px solid @color-border;
    border-radius: @radius-sm;
    background: @color-bg;
    color: @color-text;
    min-width: 160px;

    &:focus {
      outline: none;
      border-color: @primary;
    }
  }

  .filter-btn {
    padding: 6px 16px;
    font-size: @font-sm;
    color: #fff;
    background: @primary;
    border: none;
    border-radius: @radius-sm;
    cursor: pointer;
    transition: opacity @duration-fast;

    &:hover {
      opacity: 0.9;
    }

    &.ghost {
      background: transparent;
      color: @color-text-secondary;
      border: 1px solid @color-border;
    }
  }
}

.run-name {
  font-weight: 500;
}

.muted {
  color: @color-text-tertiary;
}

.failed-node {
  color: @color-error;
  font-weight: 500;

  small {
    color: @color-text-tertiary;
    font-weight: 400;
  }
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

    .chart-title {
      font-size: @font-lg;
      font-weight: 600;
      color: @color-text;
      margin: 0;
    }

    .error-count {
      font-size: @font-xs;
      font-weight: 500;
      color: @color-error;
      background: rgba(213, 73, 65, 0.1);
      padding: 2px 8px;
      border-radius: @radius-pill;
    }
  }

  &.activity-error {
    border-left: 3px solid @color-error;
  }

  .activity-list {
    display: flex;
    flex-direction: column;
    gap: @space-2;
    max-height: 360px;
    overflow-y: auto;
  }

  .activity-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: @space-3;
    background: @color-bg;
    border-radius: @radius-md;
    transition: background-color @duration-fast;

    &.clickable {
      cursor: pointer;

      &:hover {
        background: @color-bg-hover;
      }
    }

    .activity-info {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;

      .activity-name {
        font-size: @font-base;
        color: @color-text;
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .activity-desc {
        font-size: @font-xs;
        color: @color-text-tertiary;
        margin-top: 2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    }

    .activity-time {
      font-size: @font-xs;
      color: @color-text-tertiary;
      flex-shrink: 0;
      margin-left: @space-3;
    }

    &.error-item {
      gap: @space-2;

      .error-icon {
        color: @color-error;
        font-size: 16px;
        flex-shrink: 0;
      }

      .activity-info .activity-name {
        color: @color-error;
      }
    }
  }

  .status-badge {
    font-size: @font-xs;
    font-weight: 500;
    padding: 2px 10px;
    border-radius: @radius-pill;
    flex-shrink: 0;

    &.badge-success {
      background: rgba(43, 164, 113, 0.12);
      color: @color-success;
    }

    &.badge-error {
      background: rgba(213, 73, 65, 0.1);
      color: @color-error;
    }

    &.badge-primary {
      background: @primary-light;
      color: @primary;
    }

    &.badge-warning {
      background: rgba(227, 115, 24, 0.12);
      color: @color-warning;
    }

    &.badge-default {
      background: @color-bg-hover;
      color: @color-text-secondary;
    }
  }

  .empty-state {
    text-align: center;
    padding: @space-8;
    color: @color-text-tertiary;

    .t-icon {
      font-size: 32px;
      margin-bottom: @space-2;
      opacity: 0.5;
    }

    p {
      font-size: @font-sm;
      margin: 0;
    }
  }
}

/* ==================== 资源汇总 ==================== */
.resource-summary {
  display: flex;
  justify-content: space-around;
  background: @color-bg-surface;
  border: 1px solid @color-border;
  border-radius: @radius-card;
  padding: @space-4 @space-6;
  box-shadow: @shadow-card;

  .resource-item {
    display: flex;
    align-items: center;
    gap: @space-2;

    .t-icon {
      color: @color-text-tertiary;
      font-size: 16px;
    }

    .res-label {
      font-size: @font-sm;
      color: @color-text-secondary;
    }

    .res-value {
      font-size: @font-md;
      font-weight: 600;
      color: @color-text;
    }
  }
}

.dashboard-footer {
  text-align: right;
  padding: @space-4 0;
  font-size: @font-xs;
  color: @color-text-tertiary;
}

/* ==================== 运行详情抽屉 ==================== */
.run-drawer-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 1000;
  display: flex;
  justify-content: flex-end;
}

.run-drawer {
  position: relative;
  width: 760px;
  max-width: 94vw;
  height: 100%;
  background: @color-bg-surface;
  box-shadow: -4px 0 24px rgba(0, 0, 0, 0.15);
  display: flex;
  flex-direction: column;
  animation: drawer-slide 0.25s ease;

  .drawer-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: @space-4 @space-5;
    border-bottom: 1px solid @color-border;

    .drawer-title {
      display: flex;
      flex-direction: column;

      span:first-child {
        font-size: @font-lg;
        font-weight: 600;
        color: @color-text;
      }

      .drawer-sub {
        font-size: @font-xs;
        color: @color-text-tertiary;
        margin-top: 2px;
      }
    }

    .drawer-close {
      border: none;
      background: transparent;
      cursor: pointer;
      font-size: 20px;
      color: @color-text-tertiary;

      &:hover {
        color: @color-text;
      }
    }
  }

  .drawer-loading {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: @color-text-tertiary;
    gap: @space-3;

    .t-icon {
      font-size: 32px;
    }
  }

  .drawer-tabs {
    display: flex;
    border-bottom: 1px solid @color-border;
    padding: 0 @space-5;

    .detail-tab {
      padding: @space-3 @space-4;
      font-size: @font-sm;
      color: @color-text-secondary;
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      transition: all @duration-fast;

      &:hover {
        color: @color-text;
      }

      &.active {
        color: @primary;
        border-bottom-color: @primary;
        font-weight: 500;
      }
    }
  }

  .drawer-body {
    flex: 1;
    overflow-y: auto;
    padding: @space-5;
  }

  .detail-pane {
    display: flex;
    flex-direction: column;
    gap: @space-4;
  }

  .kv-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: @space-3;

    .kv {
      display: flex;
      justify-content: space-between;
      padding: @space-2 @space-3;
      background: @color-bg;
      border-radius: @radius-md;
      border: 1px solid @color-border;

      .kv-k {
        font-size: @font-sm;
        color: @color-text-secondary;
      }

      .kv-v {
        font-size: @font-sm;
        color: @color-text;
        font-weight: 500;
      }
    }
  }

  .error-box,
  .io-block {
    border: 1px solid @color-border;
    border-radius: @radius-md;
    overflow: hidden;

    .error-box-head,
    .io-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: @space-2 @space-3;
      background: @color-bg;
      font-size: @font-sm;
      color: @color-text-secondary;
      border-bottom: 1px solid @color-border;
    }

    .error-pre,
    .io-pre {
      margin: 0;
      padding: @space-3;
      font-size: @font-xs;
      line-height: 1.6;
      color: @color-text;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 240px;
      overflow: auto;
      font-family: @font-mono;
    }

    &.error-box .error-pre {
      color: @color-error;
    }
  }

  .node-trace {
    border: 1px solid @color-border;
    border-radius: @radius-md;
    padding: @space-3;
    background: @color-bg;

    &.node-failed {
      border-left: 3px solid @color-error;
    }

    .node-trace-head {
      display: flex;
      align-items: center;
      gap: @space-2;
      flex-wrap: wrap;
    }

    .node-idx {
      font-size: @font-xs;
      font-weight: 600;
      color: @primary;
      background: @primary-light;
      padding: 2px 8px;
      border-radius: @radius-sm;
    }

    .node-label {
      font-size: @font-sm;
      font-weight: 500;
      color: @color-text;
    }

    .node-dur {
      font-size: @font-xs;
      color: @color-text-tertiary;
      margin-left: auto;
    }

    .node-meta {
      font-size: @font-xs;
      color: @color-text-tertiary;
      margin-top: 4px;
    }

    .node-error {
      font-size: @font-xs;
      color: @color-error;
      margin-top: 4px;
    }

    .node-io {
      margin-top: @space-2;

      summary {
        cursor: pointer;
        font-size: @font-xs;
        color: @primary;
      }
    }
  }

  .log-pre {
    margin: 0;
    padding: @space-3;
    background: #1e1e2e;
    color: #e4e4e7;
    border-radius: @radius-md;
    font-size: @font-xs;
    line-height: 1.7;
    white-space: pre-wrap;
    font-family: @font-mono;
    max-height: 60vh;
    overflow: auto;
  }
}

@keyframes drawer-slide {
  from {
    transform: translateX(100%);
  }

  to {
    transform: translateX(0);
  }
}
</style>
