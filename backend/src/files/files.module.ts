import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { FileGeneratorService } from './file-generator.service';
import { FileStorageService } from './file-storage.service';
import { FilePreviewService } from './file-preview.service';

/**
 * Files 模块 —— 统一的「文件生成 + 存储 + 预览 + 下载」基础服务。
 *
 * 设计目标：这是一项公共能力，不只服务于聊天页。
 *   Chat / Agent → generate_file 工具
 *   Workflow     → 文件输出节点（后续）
 *   Skill        → 声明输出格式（后续）
 *
 * 各服务职责：
 *   FileGeneratorService  统一调度 docx / xlsx / pdf / md / csv 生成器
 *   FileStorageService    上传对象存储 + 文件元数据持久化
 *   FilePreviewService    读取并转换文件内容为可预览数据
 *   FilesService          业务门面 + 权限校验
 *   FilesController       HTTP 接口
 */
@Module({
  imports: [PrismaModule, StorageModule],
  controllers: [FilesController],
  providers: [
    FilesService,
    FileGeneratorService,
    FileStorageService,
    FilePreviewService,
  ],
  exports: [FilesService, FileGeneratorService],
})
export class FilesModule {}
