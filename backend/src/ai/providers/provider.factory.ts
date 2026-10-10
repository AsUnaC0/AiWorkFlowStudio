import { AiProvider } from '../ai-provider.interface';
import { OllamaProvider } from './ollama.provider';
import { OpenAICompatibleProvider } from './openai-compatible.provider';
import { DeepSeekProvider } from './deepseek.provider';

/** 提供商类型 */
export type LlmProviderType =
  | 'ollama'
  | 'openai'
  | 'deepseek'
  | 'openai-compatible';

/** 各云端厂商未显式配置 baseUrl 时的默认值 */
export const DEFAULT_BASE_URL: Record<Exclude<LlmProviderType, 'ollama'>, string> =
  {
    openai: 'https://api.openai.com/v1',
    deepseek: 'https://api.deepseek.com/v1',
    'openai-compatible': '',
  };

export interface ProviderConnectionInput {
  provider: LlmProviderType;
  baseUrl?: string | null;
  apiKey?: string | null;
}

/**
 * 根据连接配置创建一个可用的 AiProvider 实例。
 *
 * - ollama：直连本地/自定义 Ollama 地址，无需 apiKey。
 * - openai / deepseek / openai-compatible：走 OpenAI 协议，baseUrl 缺失时取默认值。
 *
 * 该函数不依赖 NestJS DI（Provider 是纯类），便于在 LlmConfigService 里按需构造。
 */
export function createProvider(input: ProviderConnectionInput): AiProvider {
  const { provider, baseUrl, apiKey } = input;

  switch (provider) {
    case 'ollama':
      return new OllamaProvider(baseUrl || undefined);
    case 'deepseek':
      return new DeepSeekProvider(baseUrl || undefined, apiKey || undefined);
    case 'openai':
      return new OpenAICompatibleProvider(
        baseUrl || DEFAULT_BASE_URL.openai,
        apiKey || undefined,
        'openai',
      );
    case 'openai-compatible':
      if (!baseUrl) {
        throw new Error('openai-compatible 类型必须提供 baseUrl');
      }
      return new OpenAICompatibleProvider(baseUrl, apiKey || undefined);
    default:
      throw new Error(`不支持的提供商类型: ${provider}`);
  }
}
