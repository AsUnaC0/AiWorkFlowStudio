import { OpenAICompatibleProvider } from './openai-compatible.provider';

/**
 * DeepSeek Provider —— DeepSeek 官方 API 与 OpenAI 完全兼容，
 * 仅默认 baseUrl 不同（`https://api.deepseek.com/v1`）。
 * 用户自定义时也可覆盖 baseUrl（例如走代理/兼容网关）。
 */
export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(baseUrl?: string, apiKey?: string) {
    super(baseUrl || 'https://api.deepseek.com/v1', apiKey, 'deepseek');
  }
}
