import { Global, Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AI_PROVIDER } from './ai-provider.interface';
import { AIService } from './ai.service';
import { OllamaProvider } from './providers/ollama.provider';

@Global()
@Module({
  controllers: [AiController],
  providers: [{ provide: AI_PROVIDER, useClass: OllamaProvider }, AIService],
  exports: [AIService],
})
export class AiModule {}
