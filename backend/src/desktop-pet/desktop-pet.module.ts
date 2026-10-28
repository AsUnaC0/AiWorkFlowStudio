import { Module } from '@nestjs/common';
import { DesktopPetController } from './desktop-pet.controller';
import { DesktopPetService } from './desktop-pet.service';

/**
 * DesktopPetModule —— 桌宠客户端（`desktop/`）的启动器。
 *
 * 只做一件事：把本机的 Electron 进程拉起来。不依赖 Prisma，也不碰业务表 ——
 * 桌宠的所有业务请求都走既有接口（auth / platform/assistant / agents/:id/chat/stream），
 * 这里再存一份配置只会两边不同步。
 */
@Module({
  controllers: [DesktopPetController],
  providers: [DesktopPetService],
})
export class DesktopPetModule {}
