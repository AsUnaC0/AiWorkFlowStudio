import { Global, Module } from '@nestjs/common';
import { AIService } from './ai.service';
import { OllamaProvider } from './providers/ollama.provider';

@Global()
@Module({
  providers: [OllamaProvider, AIService],
  exports: [AIService],
})
export class AiModule {}
