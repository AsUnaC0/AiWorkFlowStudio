import { Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { JwtUser } from '../auth/strategies/jwt.strategy';
import { DesktopPetService } from './desktop-pet.service';

/**
 * 桌宠客户端接口。
 *
 *   POST /desktop-pet/launch — 在本机拉起桌宠（已启动则唤起它的窗口）
 *
 * 只有这一个接口是必要的：桌宠自己的网络请求（登录 / 拉助理信息 / SSE 对话）
 * 都直接打现有接口，不需要经过这里。启动是唯一「必须由外部代劳」的动作，
 * 因为浏览器起不了本地进程。
 *
 * 权限：需要登录。这里把当前请求的 token 转交给桌宠，
 * 让它在后台完成登录、**不弹登录面板** —— 用户能点这个按钮，说明他已经在网页登录过了。
 */
@Controller('desktop-pet')
@UseGuards(JwtAuthGuard)
export class DesktopPetController {
  constructor(private readonly desktopPetService: DesktopPetService) {}

  @Post('launch')
  async launch(@Req() req: Request, @CurrentUser() user: JwtUser) {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';

    // 桌宠需要知道连哪个后端：用请求自身的 Host 推断，
    // 这样用户把后端起在 3100 时桌宠也自动跟着走，不用手填。
    const host = req.headers.host ?? 'localhost:3000';
    const baseUrl = `http://${host}`;

    return this.desktopPetService.launch({
      token,
      baseUrl,
      userId: user.id,
      email: user.email,
    });
  }
}
