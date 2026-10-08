import {
  ConflictException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface FriendListItem {
  id: string;
  username: string;
  email: string;
  avatar: string | null;
  status: string;
  friendshipId: string;
  friendshipStatus: string;
  isInitiator: boolean;
  createdAt: Date;
}

export interface UserSearchResult {
  id: string;
  username: string;
  email: string;
  avatar: string | null;
  status: string;
  /** 与当前用户的已有好友关系（null = 无关系） */
  existingFriendship: {
    id: string;
    status: string;
    isInitiator: boolean;
  } | null;
}

@Injectable()
export class FriendshipService {
  constructor(private readonly prisma: PrismaService) {}

  /** 搜索用户（按 username 或 email 模糊匹配） */
  async searchUsers(userId: string, keyword: string): Promise<UserSearchResult[]> {
    const trimmed = keyword.trim();
    if (!trimmed) return [];

    const users = await this.prisma.user.findMany({
      where: {
        AND: [
          { id: { not: userId } },
          {
            OR: [
              { username: { contains: trimmed, mode: 'insensitive' } },
              { email: { contains: trimmed, mode: 'insensitive' } },
            ],
          },
        ],
      },
      take: 20,
      orderBy: { createdAt: 'desc' },
    });

    // 批量查已有好友关系
    const existing = await this.prisma.friendship.findMany({
      where: {
        OR: [
          { userId, friendId: { in: users.map((u) => u.id) } },
          { friendId: userId, userId: { in: users.map((u) => u.id) } },
        ],
      },
    });

    const map = new Map<string, (typeof existing)[number]>();
    for (const f of existing) {
      const other = f.userId === userId ? f.friendId : f.userId;
      map.set(other, f);
    }

    return users.map((u) => {
      const fs = map.get(u.id);
      return {
        id: u.id,
        username: u.username,
        email: u.email,
        avatar: u.avatar,
        status: u.status,
        existingFriendship: fs
          ? {
              id: fs.id,
              status: fs.status,
              isInitiator: fs.userId === userId,
            }
          : null,
      };
    });
  }

  /** 发送好友请求 */
  async sendRequest(userId: string, friendId: string) {
    if (userId === friendId) {
      throw new BadRequestException('不能添加自己为好友');
    }

    const friend = await this.prisma.user.findUnique({ where: { id: friendId } });
    if (!friend) throw new NotFoundException('用户不存在');

    // 检查是否已存在关系（正向或反向）
    const existing = await this.prisma.friendship.findFirst({
      where: {
        OR: [
          { userId, friendId },
          { userId: friendId, friendId: userId },
        ],
      },
    });

    if (existing) {
      if (existing.status === 'ACCEPTED') {
        throw new ConflictException('你们已经是好友了');
      }
      if (existing.status === 'PENDING') {
        if (existing.userId === userId) {
          throw new ConflictException('已发送过好友请求');
        }
        // 对方曾发起请求 → 直接接受
        return this.acceptRequest(userId, existing.id);
      }
      if (existing.status === 'REJECTED' || existing.status === 'BLOCKED') {
        // 清除旧的，重新发起
        await this.prisma.friendship.delete({ where: { id: existing.id } });
      }
    }

    return this.prisma.friendship.create({
      data: { userId, friendId, status: 'PENDING' },
      include: { friend: true },
    });
  }

  /** 列出我的好友（ACCEPTED + PENDING sent/received） */
  async listAll(userId: string): Promise<{
    friends: FriendListItem[];
    pendingReceived: FriendListItem[];
    pendingSent: FriendListItem[];
  }> {
    const friendships = await this.prisma.friendship.findMany({
      where: {
        OR: [{ userId }, { friendId: userId }],
      },
      include: {
        user: true,
        friend: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    const mapToItem = (fs: (typeof friendships)[number]): FriendListItem => {
      const isInitiator = fs.userId === userId;
      const other = isInitiator ? fs.friend : fs.user;
      return {
        id: other.id,
        username: other.username,
        email: other.email,
        avatar: other.avatar,
        status: other.status,
        friendshipId: fs.id,
        friendshipStatus: fs.status,
        isInitiator,
        createdAt: fs.createdAt,
      };
    };

    const friends: FriendListItem[] = [];
    const pendingReceived: FriendListItem[] = [];
    const pendingSent: FriendListItem[] = [];

    for (const fs of friendships) {
      if (fs.status === 'ACCEPTED') {
        friends.push(mapToItem(fs));
      } else if (fs.status === 'PENDING') {
        if (fs.userId === userId) pendingSent.push(mapToItem(fs));
        else pendingReceived.push(mapToItem(fs));
      }
      // REJECTED / BLOCKED 不在列表展示
    }

    return { friends, pendingReceived, pendingSent };
  }

  /** 接受好友请求 */
  async acceptRequest(userId: string, friendshipId: string) {
    const fs = await this.prisma.friendship.findUnique({
      where: { id: friendshipId },
    });
    if (!fs) throw new NotFoundException('好友请求不存在');

    // 只有接收者能接受
    if (fs.friendId !== userId) {
      throw new BadRequestException('无权操作');
    }
    if (fs.status !== 'PENDING') {
      throw new BadRequestException('请求已处理');
    }

    return this.prisma.friendship.update({
      where: { id: friendshipId },
      data: { status: 'ACCEPTED' },
    });
  }

  /** 拒绝好友请求 */
  async rejectRequest(userId: string, friendshipId: string) {
    const fs = await this.prisma.friendship.findUnique({
      where: { id: friendshipId },
    });
    if (!fs) throw new NotFoundException('好友请求不存在');
    if (fs.friendId !== userId) throw new BadRequestException('无权操作');
    if (fs.status !== 'PENDING') throw new BadRequestException('请求已处理');

    return this.prisma.friendship.update({
      where: { id: friendshipId },
      data: { status: 'REJECTED' },
    });
  }

  /** 删除好友（双向都可删除） */
  async removeFriend(userId: string, friendId: string) {
    const fs = await this.prisma.friendship.findFirst({
      where: {
        OR: [
          { userId, friendId },
          { userId: friendId, friendId: userId },
        ],
        status: 'ACCEPTED',
      },
    });
    if (!fs) throw new NotFoundException('好友关系不存在');

    return this.prisma.friendship.delete({ where: { id: fs.id } });
  }

  /** 获取我的 ACCEPTED 好友 ID 列表（用于 Workspace 邀请候选） */
  async getAcceptedFriendIds(userId: string): Promise<string[]> {
    const fss = await this.prisma.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [{ userId }, { friendId: userId }],
      },
      select: { userId: true, friendId: true },
    });
    return fss.map((fs) => (fs.userId === userId ? fs.friendId : fs.userId));
  }
}
