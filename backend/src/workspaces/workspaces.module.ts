import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FriendshipModule } from '../friendship/friendship.module';
import { PrismaModule } from '../prisma/prisma.module';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

@Module({
  imports: [PrismaModule, AuthModule, FriendshipModule],
  controllers: [WorkspacesController],
  providers: [WorkspacesService],
})
export class WorkspacesModule {}
