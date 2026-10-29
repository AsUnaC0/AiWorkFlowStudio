import { AiProvider } from '../ai-provider.interface';
import { OllamaProvider } from './ollama.provider';
import { OpenAICompatibleProvider } from './openai-compatible.provider';

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
 * - openai / deepseek：同一套 OpenAI 协议实现，只是默认 baseUrl 与实例 name 不同。
 * - openai-compatible：baseUrl 必填的自定义网关。
 *
 * 该函数不依赖 NestJS DI（Provider 是纯类），便于在 LlmConfigService 里按需构造。
 */
export function createProvider(input: ProviderConnectionInput): AiProvider {
  const { provider, baseUrl, apiKey } = input;

  switch (provider) {
    case 'ollama':
      return new OllamaProvider(baseUrl || undefined);

    // openai / deepseek 走同一个分支：两者只差「默认 baseUrl」和「实例 name」，
    // 而这两者都能从 provider 类型本身推出来（DEFAULT_BASE_URL 里有各自的默认地址，
    // name 必须与类型同名 —— 它会被写进 ModelCallLog.provider，仪表盘按它分组）。
    // 新增同类厂商时，只要往 DEFAULT_BASE_URL 加一条、再挂到这个 case 上即可。
    case 'openai':
    case 'deepseek':
      return new OpenAICompatibleProvider(
        baseUrl || DEFAULT_BASE_URL[provider],
        apiKey || undefined,
        provider,
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
