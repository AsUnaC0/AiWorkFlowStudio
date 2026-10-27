# 聊天页：处理过程改为「单一气泡 + 呼吸动态 + 完成后折叠」

## Context（为什么改）

当前聊天页把 Agent 的执行轨迹 `msg.trail`（thinking / tool_call / tool_result / operation / file）逐行渲染成一条条独立的小药丸（`index.vue:1098-1159`），等待期间显示静态文字「💭 思考中... (第 N 轮)」。用户反馈三点问题：

1. 等待数据期间应是**呼吸动态**样式，数据到达后停止呼吸、以打字机方式展示（沿用 SSE 自然流式，不做前端逐字动画）。
2. 「✅ 返回结果（xxms）」及其结果详情**完全隐藏**；「🔧 调用 xxx」保留；平台**操作卡片保留**（含风险标签与「打开资源」跳转）。
3. 处理过程**在同一个对话气泡内展示**：流式期间自动展开（实时可见），拿到最终数据后气泡**自动折叠**，只显示最终回答；用户点击头部可展开/折叠查看处理过程。历史会话回放同样支持折叠/展开。

后端无需改动：`agent.service.ts` 已把 thinking/tool_call/tool_result/operation/file 全部写入 `ChatMessage.trail` 持久化，前端只改渲染与状态。

## 改动文件

仅 `fronted/src/views/chat/index.vue`（Vue3 SFC）。

## 一、script 改动

**1. 替换 289-292 行** `expandedTrails` / `toggleTrail`，新增：

```ts
/** 当前正在流式接收的那条 assistant 消息 id（单流，单值即可） */
const streamingMsgId = ref<string | null>(null);
/** 已完成消息的「处理过程」折叠态集合（流式中的消息恒为展开） */
const expandedProcesses = ref<Set<string>>(new Set());
const toggleProcess = (msgId: string) => {
  if (expandedProcesses.value.has(msgId)) expandedProcesses.value.delete(msgId);
  else expandedProcesses.value.add(msgId);
};
/** 展开判定：流式中的消息始终展开；已完成消息按用户点击状态 */
const processExpanded = (msg: ChatMessage) =>
  streamingMsgId.value === msg.id || expandedProcesses.value.has(msg.id);
/** 只保留 tool_call + operation（过滤 thinking / tool_result / file） */
const processSteps = (msg: ChatMessage) =>
  (msg.trail ?? []).filter(
    (s) => s.type === "tool_call" || s.type === "operation",
  );
const hasProcess = (msg: ChatMessage) => processSteps(msg).length > 0;
const processStepCount = (msg: ChatMessage) => processSteps(msg).length;
```

**2. `send()` 改动**：
- `sending.value = true`（约 745 行）后加 `streamingMsgId.value = assistantMsgId;`
- `finally`（约 769-777 行）内 `sending.value = false` 后加：
  ```ts
  streamingMsgId.value = null; // 流结束
  expandedProcesses.value.delete(assistantMsgId); // 拿到最终数据 → 自动折叠
  ```
  （AbortError 提前 return 不影响：finally 总会执行。）

**3. 删除死代码**：`formatToolResult`（909-913 行，唯一引用点在将被删除的 tool_result 渲染处）。`formatToolArgs` 保留。

## 二、模板改动（1098-1168 行）

**替换 1098-1159 行整个 `v-if="msg.trail..."` 轨迹块**为：

```html
<!-- 处理过程：单一气泡内的可折叠区块（仅 assistant 且有过程步骤时） -->
<div v-if="msg.role === 'assistant' && hasProcess(msg)" class="process">
  <button class="process-head" :class="{ expanded: processExpanded(msg) }"
    @click="toggleProcess(msg.id)">
    <t-icon name="chevron-down" class="process-chevron" />
    <span v-if="streamingMsgId === msg.id && !msg.content">正在处理…</span>
    <span v-else>⚙️ 处理过程（{{ processStepCount(msg) }} 步）</span>
    <span v-if="streamingMsgId === msg.id && !msg.content" class="process-breathing">
      <i></i><i></i><i></i>
    </span>
  </button>
  <div v-if="processExpanded(msg)" class="process-body">
    <div v-for="(step, sIdx) in processSteps(msg)" :key="sIdx"
      class="process-step" :class="String(step.type)">
      <template v-if="step.type === 'tool_call'">
        <span class="step-icon">🔧</span>
        <span class="step-text">调用 <code>{{ (step as any).tool }}</code></span>
        <pre v-if="(step as any).args" class="tool-args">{{ formatToolArgs((step as any).args) }}</pre>
      </template>
      <!-- operation：把原 1133-1156 行 operation-card 标记原样搬入（riskMeta/statusMeta/stepOperation/打开资源按钮） -->
      <template v-else-if="step.type === 'operation'">
        <!-- 原 operation-card 完整结构，一字不动 -->
      </template>
    </div>
  </div>
</div>
```

**替换 1161-1168 行内容区**（移除旧三圆点 `.typing`；呼吸只在本条消息流式且无内容时出现）：

```html
<div class="message-content">
  {{ msg.content }}
  <!-- 无处理过程时：纯聊天等待，内容区显示呼吸 -->
  <div v-if="streamingMsgId === msg.id && !msg.content && !hasProcess(msg)"
    class="content-breathing">
    <i></i><i></i><i></i><span>思考中…</span>
  </div>
</div>
```

要点：
- 有过程步骤时呼吸点在 `.process-head`（顶部，始终可见）；无过程时呼吸点在内容区。**同一时刻只有一处呼吸指示**。
- `message` SSE 事件到达后 `msg.content` 非空 → 呼吸自动消失，正文随 token 自然打字展示（不做前端逐字动画）。
- 流式期间头部显示「正在处理…」；流结束 finally 折叠后，头部变为「⚙️ 处理过程（N 步）」+ 旋转箭头。

## 三、CSS 改动

- **删除** 2039-2119 行 `.trail` / `.trail-step` 整块（含 `.thinking` / `.tool_result` 变体、`.tool-toggle`、`.tool-result`），以及 1958-1978 行 `.message-content` 内 `.typing`。
- **保留** `.operation-card`（2147+）不动。
- **新增**（置于原 `.trail` 位置，全部复用 variables.less 变量）：

```less
@keyframes process-breathe {
  0%, 100% { opacity: .3; transform: scale(.8); }
  50% { opacity: 1; transform: scale(1); }
}
.process {
  width: 100%;
  margin-bottom: @space-2;
  border: 1px solid @color-border;
  border-radius: @radius-lg;
  overflow: hidden;
}
.process-head {
  display: flex; align-items: center; gap: 6px;
  width: 100%; padding: @space-1 @space-3;
  background: @primary-light; color: @primary;
  font-size: @font-xs; cursor: pointer; border: none; text-align: left;
  .process-chevron { transition: transform .2s; font-size: 14px; }
  &.expanded .process-chevron { transform: rotate(180deg); }
}
.process-body {
  padding: @space-2 @space-3;
  display: flex; flex-direction: column; gap: 4px;
  max-height: 320px; overflow-y: auto;
  .process-step {
    display: flex; align-items: flex-start; gap: 6px;
    padding: 4px 8px; border-radius: 6px; font-size: @font-xs;
    &.tool_call { background: @primary-light; color: @primary; }
    &.operation { display: block; padding: 0; background: transparent; }
    code {
      font-family: @font-mono; background: rgba(0,0,0,.06);
      padding: 1px 5px; border-radius: 3px; font-size: 11px;
    }
    .tool-args {
      margin: 2px 0 0 20px; padding: 8px 10px; border-radius: 6px;
      background: rgba(0,0,0,.04); font-size: 11px; font-family: @font-mono;
      max-height: 250px; overflow-y: auto; white-space: pre-wrap;
      word-break: break-all; width: 100%;
    }
  }
}
.process-breathing {
  display: inline-flex; gap: 4px; margin-left: @space-1;
  i {
    width: 6px; height: 6px; border-radius: 50%;
    background: @primary;
    animation: process-breathe 1.2s ease-in-out infinite;
    &:nth-child(2) { animation-delay: .2s; }
    &:nth-child(3) { animation-delay: .4s; }
  }
}
.content-breathing {
  display: inline-flex; align-items: center; gap: 6px;
  margin-top: @space-2;
  i {
    width: 6px; height: 6px; border-radius: 50%;
    background: @color-text-tertiary;
    animation: process-breathe 1.2s ease-in-out infinite;
    &:nth-child(2) { animation-delay: .2s; }
    &:nth-child(3) { animation-delay: .4s; }
  }
  span { color: @color-text-tertiary; font-size: @font-xs; }
}
```

## 边界情况

- **历史回放**：trail 已持久化，`streamingMsgId` 为 null → 默认折叠，点头部展开；只含 thinking 的旧消息 `hasProcess=false` → 不渲染进程块，只显示答案。
- **空助手气泡**（已知问题，不在本次范围）：内容区渲染 `msg.content`（空则空），行为与现状一致，不新增逻辑。
- **error 事件**：`msg.content` 变「⚠️ ...」→ 呼吸停止、头部转静态「⚙️ 处理过程」、finally 照常折叠。
- **纯聊天（无 trail）**：无进程块，内容区呼吸点正常工作。
- **文件卡片**：走 `msg.files` 独立渲染（1186-1189），完全不动；trail 里的 `file` 步骤被 `processSteps` 过滤掉。

## 验证

1. `cd fronted && npm run build`（`vue-tsc -b && vite build`，捕获类型/模板错误）。
2. `npm run dev` 手动验证：
   - 发一条触发多轮思考 + 工具调用的消息（如平台助理建工作流草稿）→ 观察呼吸动画、进程块自动展开、`message` 到达后呼吸停止、流结束自动折叠只剩答案；
   - 折叠后点头部展开 → 只见「🔧 调用 xxx」行与操作卡片，**无任何 ✅ / tool_result 行**；
   - 切走再切回（keep-alive 历史回放）→ 默认折叠、可展开；
   - 纯聊天消息 → 内容区呼吸点正常、答案打字机展示；
   - 触发 error 场景 → 无呼吸残留、无折叠异常。
