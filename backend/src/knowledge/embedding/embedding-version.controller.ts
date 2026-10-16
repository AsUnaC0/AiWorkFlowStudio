import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { JwtUser } from '../../auth/strategies/jwt.strategy';
import { EmbeddingVersionService } from './embedding-version.service';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

class CreateVersionDto {
  /** 目标向量模型在「模型管理」中的 id（推荐：自带实测维度） */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  llmModelId?: string;

  /** 直接指定模型标识（如本地 Ollama 的 nomic-embed-text） */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  modelId?: string;

  /** 目标维度；指定 llmModelId 时以模型实测维度为准 */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8192)
  dimensions?: number;
}

/**
 * 知识库向量版本 / 重新向量化接口。
 *
 * 设计要点：切换模型不会直接改现有数据 —— 先建目标版本，后台重新向量化，
 * 校验通过后再由用户（或前端）显式激活，旧版本保留可回滚。
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class EmbeddingVersionController {
  constructor(
    private readonly versionService: EmbeddingVersionService,
    @InjectQueue('knowledge-reembed')
    private readonly reEmbedQueue: Queue,
  ) {}

  /** 列出某知识库的全部向量版本（含进度） */
  @Get('knowledge-bases/:id/embedding-versions')
  listVersions(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.versionService.listVersions(user.id, id);
  }

  /** 当前生效版本（没有则按知识库配置补建） */
  @Get('knowledge-bases/:id/embedding-versions/active')
  activeVersion(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.versionService.ensureActiveVersion(id).then(async () => {
      const versions = await this.versionService.listVersions(user.id, id);
      return versions.find((v) => v.isActive) ?? null;
    });
  }

  /** 创建目标向量版本（不立即生效） */
  @Post('knowledge-bases/:id/embedding-versions')
  async createVersion(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateVersionDto,
  ) {
    const version = await this.versionService.createTargetVersion(
      user.id,
      id,
      dto,
    );
    return version;
  }

  /** 启动 / 继续重新向量化任务 */
  @Post('knowledge-bases/:id/embedding-versions/:versionId/re-embed')
  async startReEmbed(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Body() body?: { retryFailedOnly?: boolean },
  ) {
    const version = await this.versionService.getVersion(user.id, id, versionId);
    const job = await this.reEmbedQueue.add(
      're-embed',
      {
        knowledgeBaseId: id,
        versionId: version.id,
        retryFailedOnly: body?.retryFailedOnly ?? false,
      },
      {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 50,
        removeOnFail: 100,
      },
    );
    return { versionId: version.id, jobId: job.id, status: 'PROCESSING' };
  }

  /** 激活指定版本（必须已 READY） */
  @Post('knowledge-bases/:id/embedding-versions/:versionId/activate')
  activate(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
  ) {
    return this.versionService.activateVersion(user.id, id, versionId);
  }

  /** 删除（归档）某个历史版本 */
  @Delete('knowledge-bases/:id/embedding-versions/:versionId')
  remove(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
  ) {
    return this.versionService.deleteVersion(user.id, id, versionId);
  }
}
