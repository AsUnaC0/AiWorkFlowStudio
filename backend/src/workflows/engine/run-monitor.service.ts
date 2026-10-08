import { Injectable, Logger } from '@nestjs/common';

/**
 * 运行监控服务 —— 统一控制台日志格式 + 后续可扩展为 SSE/WebSocket 推送。
 *
 * 日志层级：
 *   Run 级  → WorkflowRun 开始 / 完成 / 失败
 *   Node 级 → Node 开始 / 完成 / 失败（含耗时）
 *
 * 日志格式：
 *   [WorkflowRun #<runId>] ▶ start  workflow=<workflowId>
 *   [WorkflowRun #<runId>] ● node:start  <nodeType>:<nodeId>  label="<label>"
 *   [WorkflowRun #<runId>] ● node:done   <nodeType>:<nodeId>  123ms  SUCCESS
 *   [WorkflowRun #<runId>] ● node:fail   <nodeType>:<nodeId>  45ms   <error>
 *   [WorkflowRun #<runId>] ✔ complete  456ms
 *   [WorkflowRun #<runId>] ✖ failed    456ms  <error>
 *
 * 对于无 runId 的同步测试路径，用 "ad-hoc" 标记。
 */
@Injectable()
export class RunMonitorService {
  private readonly logger = new Logger('WorkflowRun');

  // ---------------------------------------------------------------------------
  // Run 级
  // ---------------------------------------------------------------------------

  logRunStart(runId: string | null, workflowId: string) {
    this.logger.log(
      `${this.tag(runId)} ▶ start  workflow=${workflowId}`,
    );
  }

  logRunComplete(runId: string | null, durationMs: number) {
    this.logger.log(
      `${this.tag(runId)} ✔ complete  ${this.fmtDuration(durationMs)}`,
    );
  }

  logRunFailed(runId: string | null, durationMs: number, error: string) {
    this.logger.error(
      `${this.tag(runId)} ✖ failed   ${this.fmtDuration(durationMs)}  ${error}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Node 级
  // ---------------------------------------------------------------------------

  logNodeStart(
    runId: string | null,
    nodeType: string,
    nodeId: string,
    label?: string,
  ) {
    const labelSuffix = label ? `  label="${label}"` : '';
    this.logger.log(
      `${this.tag(runId)} ● node:start  ${nodeType}:${nodeId}${labelSuffix}`,
    );
  }

  logNodeComplete(
    runId: string | null,
    nodeType: string,
    nodeId: string,
    durationMs: number,
    branch?: string,
  ) {
    const branchSuffix = branch ? `  branch=${branch}` : '';
    this.logger.log(
      `${this.tag(runId)} ● node:done   ${nodeType}:${nodeId}  ${this.fmtDuration(durationMs)}  SUCCESS${branchSuffix}`,
    );
  }

  logNodeFailed(
    runId: string | null,
    nodeType: string,
    nodeId: string,
    durationMs: number,
    error: string,
  ) {
    this.logger.error(
      `${this.tag(runId)} ● node:fail   ${nodeType}:${nodeId}  ${this.fmtDuration(durationMs)}  ${error}`,
    );
  }

  logNodeSkipped(
    runId: string | null,
    nodeType: string,
    nodeId: string,
    reason: string,
  ) {
    this.logger.warn(
      `${this.tag(runId)} ● node:skip   ${nodeType}:${nodeId}  ${reason}`,
    );
  }

  // ---------------------------------------------------------------------------
  // 内部工具
  // ---------------------------------------------------------------------------

  /** 日志前缀：[WorkflowRun #<runId>] 或 [WorkflowRun #ad-hoc] */
  private tag(runId: string | null): string {
    return `[WorkflowRun #${runId ?? 'ad-hoc'}]`;
  }

  /** 耗时格式化：< 1s 用 ms，否则用 s */
  private fmtDuration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  }
}
