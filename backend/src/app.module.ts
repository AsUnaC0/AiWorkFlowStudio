import { Module } from '@nestjs/common';
import { AiModule } from './ai/ai.module';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { WorkflowsModule } from './workflows/workflows.module';

@Module({
  imports: [
    PrismaModule,
    AiModule,
    AuthModule,
    WorkspacesModule,
    WorkflowsModule,
  ],
})
export class AppModule {}
