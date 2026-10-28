import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AgentModule } from './agent/agent.module';
import { AiModule } from './ai/ai.module';
import { AssistantModule } from './assistant/assistant.module';
import { AuthModule } from './auth/auth.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { FilesModule } from './files/files.module';
import { ChatFilesModule } from './chat-files/chat-files.module';
import { FriendshipModule } from './friendship/friendship.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { LlmConfigModule } from './llm-config/llm-config.module';
import { McpModule } from './mcp/mcp.module';
import { MemoryModule } from './memory/memory.module';
import { PersonaModule } from './persona/persona.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueuesModule } from './queues/queues.module';
import { SkillModule } from './skill/skill.module';
import { StorageModule } from './storage/storage.module';
import { TtsModule } from './tts/tts.module';
import { DesktopPetModule } from './desktop-pet/desktop-pet.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { WorkflowsModule } from './workflows/workflows.module';

@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT || 6379),
      },
    }),
    PrismaModule,
    AiModule,
    AuthModule,
    DashboardModule,
    FilesModule,
    FriendshipModule,
    KnowledgeModule,
    ChatFilesModule,
    LlmConfigModule,
    WorkspacesModule,
    WorkflowsModule,
    QueuesModule,
    AgentModule,
    AssistantModule,
    PersonaModule,
    MemoryModule,
    SkillModule,
    McpModule,
    StorageModule,
    TtsModule,
    DesktopPetModule,
  ],
})
export class AppModule {}
