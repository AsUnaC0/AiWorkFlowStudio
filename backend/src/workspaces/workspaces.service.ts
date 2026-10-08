import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import { FriendshipService } from '../friendship/friendship.service';

const workspaceSelection = {
  id: true,
  name: true,
  ownerId: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { members: true, workflows: true } },
} as const;

export interface WorkspaceMemberItem {
  userId: string;
  username: string;
  email: string;
  avatar: string | null;
  status: string;
  role: 'OWNER' | 'MEMBER';
  joinedAt: Date;
}

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly friendshipService: FriendshipService,
  ) {}

  create(userId: string, dto: CreateWorkspaceDto) {
    return this.prisma.workspace.create({
      data: {
        name: dto.name,
        ownerId: userId,
        members: {
          create: { userId },
        },
      },
      select: workspaceSelection,
    });
  }

  findAll(userId: string) {
    return this.prisma.workspace.findMany({
      where: {
        OR: [{ ownerId: userId }, { members: { some: { userId } } }],
      },
      orderBy: { createdAt: 'desc' },
      select: workspaceSelection,
    });
  }

  async findOne(userId: string, id: string) {
    const workspace = await this.prisma.workspace.findFirst({
      where: {
        id,
        OR: [{ ownerId: userId }, { members: { some: { userId } } }],
      },
      select: workspaceSelection,
    });

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    return workspace;
  }

  async update(userId: string, id: string, dto: UpdateWorkspaceDto) {
    await this.assertOwner(userId, id);

    return this.prisma.workspace.update({
      where: { id },
      data: { name: dto.name },
      select: workspaceSelection,
    });
  }

  async remove(userId: string, id: string) {
    await this.assertOwner(userId, id);

    return this.prisma.workspace.delete({
      where: { id },
      select: workspaceSelection,
    });
  }

  // ---------- 成员管理 ----------

  async listMembers(
    userId: string,
    workspaceId: string,
  ): Promise<WorkspaceMemberItem[]> {
    const workspace = await this.prisma.workspace.findFirst({
      where: {
        id: workspaceId,
        OR: [{ ownerId: userId }, { members: { some: { userId } } }],
      },
      select: { ownerId: true },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');

    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    });

    return members.map((m) => ({
      userId: m.user.id,
      username: m.user.username,
      email: m.user.email,
      avatar: m.user.avatar,
      status: m.user.status,
      role: m.user.id === workspace.ownerId ? 'OWNER' : 'MEMBER',
      joinedAt: m.createdAt,
    }));
  }

  async inviteMember(
    inviterUserId: string,
    workspaceId: string,
    inviteeId: string,
  ): Promise<WorkspaceMemberItem> {
    // 1. 校验 workspace 存在 + 邀请者是成员
    const workspace = await this.prisma.workspace.findFirst({
      where: {
        id: workspaceId,
        OR: [
          { ownerId: inviterUserId },
          { members: { some: { userId: inviterUserId } } },
        ],
      },
      select: { id: true, name: true, ownerId: true },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');

    // 2. 不能邀请自己
    if (inviterUserId === inviteeId) {
      throw new BadRequestException('不能邀请自己');
    }

    // 3. 必须是 ACCEPTED 好友
    const acceptedFriendIds =
      await this.friendshipService.getAcceptedFriendIds(inviterUserId);
    if (!acceptedFriendIds.includes(inviteeId)) {
      throw new BadRequestException('只能邀请已接受的好友');
    }

    // 4. 查被邀请者是否已在 workspace
    const existing = await this.prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId, userId: inviteeId },
      },
    });
    if (existing) throw new ConflictException('该用户已在 Workspace 中');

    // 5. 创建成员记录（直接加入，不经过邀请确认流程）
    const member = await this.prisma.workspaceMember.create({
      data: { workspaceId, userId: inviteeId },
      include: { user: true },
    });

    return {
      userId: member.user.id,
      username: member.user.username,
      email: member.user.email,
      avatar: member.user.avatar,
      status: member.user.status,
      role: member.user.id === workspace.ownerId ? 'OWNER' : 'MEMBER',
      joinedAt: member.createdAt,
    };
  }

  async removeMember(
    operatorUserId: string,
    workspaceId: string,
    targetUserId: string,
  ) {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { ownerId: true },
    });
    if (!workspace) throw new NotFoundException('Workspace not found');

    // 只有 Owner 能移除成员
    if (workspace.ownerId !== operatorUserId) {
      throw new ForbiddenException('只有 Workspace Owner 能移除成员');
    }
    // 不能移除自己
    if (targetUserId === operatorUserId) {
      throw new BadRequestException('不能移除自己');
    }

    return this.prisma.workspaceMember.delete({
      where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
    });
  }

  private async assertOwner(userId: string, id: string) {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id },
      select: { ownerId: true },
    });

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    if (workspace.ownerId !== userId) {
      throw new ForbiddenException('Only the workspace owner can modify it');
    }
  }
}
