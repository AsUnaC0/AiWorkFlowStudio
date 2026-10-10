import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { EncryptionService } from '../common/crypto/encryption.service';
import { LlmConfigController } from './llm-config.controller';
import { LlmConfigService } from './llm-config.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [LlmConfigController],
  providers: [LlmConfigService, EncryptionService],
  exports: [LlmConfigService],
})
export class LlmConfigModule {}
