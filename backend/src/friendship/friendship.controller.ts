import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { JwtUser } from '../auth/strategies/jwt.strategy';
import { FriendshipService } from './friendship.service';

@Controller('friendships')
@UseGuards(JwtAuthGuard)
export class FriendshipController {
  constructor(private readonly friendshipService: FriendshipService) {}

  /** 搜索用户（按 username / email） */
  @Get('search')
  searchUsers(
    @CurrentUser() user: JwtUser,
    @Query('q') q: string,
  ) {
    return this.friendshipService.searchUsers(user.id, q);
  }

  /** 获取好友列表（ACCEPTED + PENDING 分类） */
  @Get()
  list(@CurrentUser() user: JwtUser) {
    return this.friendshipService.listAll(user.id);
  }

  /** 发送好友请求 */
  @Post('request')
  sendRequest(
    @CurrentUser() user: JwtUser,
    @Body() body: { friendId: string },
  ) {
    return this.friendshipService.sendRequest(user.id, body.friendId);
  }

  /** 接受好友请求 */
  @Post(':id/accept')
  accept(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.friendshipService.acceptRequest(user.id, id);
  }

  /** 拒绝好友请求 */
  @Post(':id/reject')
  reject(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.friendshipService.rejectRequest(user.id, id);
  }

  /** 删除好友（friendId = 对方用户 ID） */
  @Delete('friends/:friendId')
  removeFriend(
    @CurrentUser() user: JwtUser,
    @Param('friendId', ParseUUIDPipe) friendId: string,
  ) {
    return this.friendshipService.removeFriend(user.id, friendId);
  }
}
