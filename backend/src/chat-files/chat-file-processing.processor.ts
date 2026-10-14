import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ChatFilesService, CHAT_FILE_QUEUE } from './chat-files.service';

/**
 * 聊天附件异步解析处理器（BullMQ 消费者）。
 *
 * 复用 ChatFilesService.process 同一份解析逻辑；Redis 不可用时，
 * ChatFilesService 会降级为进程内后台解析，本处理器不会启动，业务不受影响。
 */
@Processor(CHAT_FILE_QUEUE)
export class ChatFileProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(ChatFileProcessingProcessor.name);

  constructor(private readonly chatFiles: ChatFilesService) {
    super();
  }

  async process(job: Job<{ attachmentId: string }>): Promise<void> {
    if (job.name !== 'parse-attachment') return;
    const { attachmentId } = job.data;
    this.logger.debug(`[ChatFileQueue] 开始解析附件 ${attachmentId}`);
    await this.chatFiles.process(attachmentId);
  }
}
