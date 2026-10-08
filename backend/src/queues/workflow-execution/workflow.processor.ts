import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkflowEngine } from '../../workflows/engine/workflow.engine';

/** workflow-execution Queue 的 Job 数据结构 */
export interface ExecuteWorkflowJobData {
  runId: string;
  workflowId: string;
  input: unknown;
}

@Processor('workflow-execution')
export class WorkflowProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workflowEngine: WorkflowEngine,
  ) {
    super();
  }

  async process(job: Job<ExecuteWorkflowJobData>): Promise<any> {
    if (job.name !== 'execute-workflow') {
      return undefined;
    }

    const { runId, workflowId, input } = job.data;

    // 1. 加载 Workflow definition（通过 currentVersion）
    const workflow = await this.prisma.workflow.findUnique({
      where: { id: workflowId },
      select: {
        id: true,
        currentVersion: {
          select: {
            definition: true,
          },
        },
      },
    });

    if (!workflow || !workflow.currentVersion) {
      throw new Error(`Workflow ${workflowId} 或其当前版本不存在`);
    }

    // 2. 更新状态为 RUNNING + 记录开始时间
    await this.prisma.workflowRun.update({
      where: { id: runId },
      data: {
        status: 'RUNNING',
        startedAt: new Date(),
      },
    });

    try {
      // 3. 执行工作流（传 runId 让 engine 记录 NodeRun + 监控日志）
      const result = await this.workflowEngine.run(
        workflow.currentVersion.definition as {
          nodes: unknown[];
          edges: unknown[];
        },
        input,
        { runId, workflowId },
      );

      // 4. 成功 → COMPLETED + output
      await this.prisma.workflowRun.update({
        where: { id: runId },
        data: {
          status: 'COMPLETED',
          output: result as any,
          completedAt: new Date(),
        },
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await this.prisma.workflowRun.update({
        where: { id: runId },
        data: {
          status: 'FAILED',
          errorMessage: message,
          completedAt: new Date(),
        },
      });

      throw error;
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    console.log(
      `[WorkflowProcessor] Job ${job.id} completed for run ${job.data?.runId}`,
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    console.error(
      `[WorkflowProcessor] Job ${job.id} failed for run ${job.data?.runId}:`,
      error.message,
    );
  }
}
