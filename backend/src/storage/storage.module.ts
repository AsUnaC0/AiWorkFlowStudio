import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';

/**
 * 统一存储模块 —— 双驱动（local / qiniu）
 *
 * 通过 STORAGE_TYPE 环境变量切换驱动，默认 local。
 * 业务模块只需 import StorageModule 即可注入 StorageService。
 */
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
