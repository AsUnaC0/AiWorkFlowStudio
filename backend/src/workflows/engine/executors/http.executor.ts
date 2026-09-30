import { Injectable, BadRequestException } from '@nestjs/common';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import {
  NodeExecutor,
  NodeExecutionContext,
  NodeExecutionResult,
} from '../node-executor.interface';
import { VariableService } from '../variable.service';
import { SsrfCheckService } from '../ssrf-check.service';

/** 支持的 HTTP 方法 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** HTTP 节点配置接口 */
export interface HttpNodeConfig {
  method?: HttpMethod;
  url?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  bodyType?: 'json';
  body?: unknown;
  timeout?: number;
}

/** HTTP 节点标准化输出 */
export interface HttpNodeOutput {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

@Injectable()
export class HttpNodeExecutor implements NodeExecutor {
  constructor(
    private readonly variableService: VariableService,
    private readonly ssrfCheckService: SsrfCheckService,
  ) {}

  async execute(
    context: NodeExecutionContext,
    node: any,
  ): Promise<NodeExecutionResult> {
    const rawConfig = (node.config ?? {}) as HttpNodeConfig;

    // 1. 校验基础配置
    this.validateConfig(rawConfig);

    // 2. 变量解析：所有配置字段都要经过变量解析
    const resolved = this.resolveAll(rawConfig, context);

    // 3. SSRF 安全检查
    this.ssrfCheckService.validate(resolved.url!);

    // 4. 构建 axios 请求配置
    const axiosConfig = this.buildAxiosConfig(resolved);

    console.log('[HTTP] 最终请求配置:', JSON.stringify(axiosConfig, null, 2));

    // 5. 发起请求
    let response: AxiosResponse;
    try {
      response = await axios(axiosConfig);
    } catch (error: any) {
      // axios 对 4xx/5xx 会 throw，我们需要把它们当作正常响应处理
      if (error.response) {
        response = error.response;
      } else {
        // 网络层真正的错误（DNS 失败、超时、连接拒绝等）
        console.error('[HTTP] 网络请求失败:', error.message);
        throw new Error(`HTTP 请求失败: ${error.message}`);
      }
    }

    // 6. 标准化输出
    const output = this.normalizeResponse(response);
    console.log('[HTTP] 响应输出:', JSON.stringify(output, null, 2));

    return { output };
  }

  /**
   * 校验配置完整性
   */
  private validateConfig(config: HttpNodeConfig): void {
    if (!config.url || !config.url.trim()) {
      throw new BadRequestException('HTTP 节点配置缺少 URL');
    }

    const method = (config.method ?? 'GET').toUpperCase();
    const validMethods: HttpMethod[] = [
      'GET',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
    ];
    if (!validMethods.includes(method as HttpMethod)) {
      throw new BadRequestException(
        `不支持的 HTTP Method: ${method}。支持: ${validMethods.join(', ')}`,
      );
    }

    // Timeout 范围：1000 ~ 120000 ms
    const timeout = config.timeout ?? 30000;
    if (timeout < 1000 || timeout > 120000) {
      throw new BadRequestException('Timeout 必须在 1000 ~ 120000 ms 之间');
    }
  }

  /**
   * 解析所有配置字段中的变量引用
   * URL / headers / query 使用 resolveAsString（必须为字符串）
   * body 使用 resolve（可以保持原始 object 类型）
   */
  private resolveAll(
    config: HttpNodeConfig,
    context: NodeExecutionContext,
  ): Required<Omit<HttpNodeConfig, 'body'>> & { body?: unknown } {
    const method = (config.method ?? 'GET').toUpperCase() as HttpMethod;
    const url = this.variableService.resolveAsString(config.url, context);
    const headers = this.resolveRecord(config.headers, context);
    const query = this.resolveRecord(config.query, context);
    const body = this.variableService.resolve(config.body, context);
    const bodyType = config.bodyType ?? 'json';
    const timeout = config.timeout ?? 30000;

    return { method, url, headers, query, bodyType, body, timeout };
  }

  /**
   * 解析 Record<string, string> 类型的变量（headers / query）
   * 同时过滤掉 key 或 value 为空的项
   */
  private resolveRecord(
    record: Record<string, string> | undefined,
    context: NodeExecutionContext,
  ): Record<string, string> {
    const result: Record<string, string> = {};
    if (!record) return result;

    for (const [key, value] of Object.entries(record)) {
      const resolvedKey = this.variableService.resolveAsString(key, context).trim();
      const resolvedValue = this.variableService.resolveAsString(value, context);

      // 跳过空 key
      if (!resolvedKey) continue;
      result[resolvedKey] = resolvedValue;
    }

    return result;
  }

  /**
   * 构建 axios 请求配置
   */
  private buildAxiosConfig(
    resolved: Required<Omit<HttpNodeConfig, 'body'>> & { body?: unknown },
  ): AxiosRequestConfig {
    const config: AxiosRequestConfig = {
      method: resolved.method,
      url: resolved.url,
      headers: resolved.headers,
      params:
        Object.keys(resolved.query).length > 0 ? resolved.query : undefined,
      timeout: resolved.timeout,
      // 不自动 throw 4xx/5xx，我们自己处理
      validateStatus: () => true,
      // 让 axios 自动解析 JSON response
      responseType: 'json',
    };

    // Body: 只有非 GET/DELETE 方法才带 body
    const hasBody = ['POST', 'PUT', 'PATCH'].includes(resolved.method);
    if (hasBody && resolved.body !== undefined && resolved.body !== null) {
      // 如果 bodyType 是 json，且 body 是 string，尝试 parse
      let bodyData = resolved.body;
      if (
        resolved.bodyType === 'json' &&
        typeof bodyData === 'string' &&
        bodyData.trim()
      ) {
        try {
          bodyData = JSON.parse(bodyData);
        } catch {
          // JSON 解析失败，当作普通字符串发送
          console.warn('[HTTP] Body JSON 解析失败，将作为字符串发送');
        }
      }

      config.data = bodyData;

      // 如果没设置 Content-Type，默认加 application/json
      if (
        resolved.bodyType === 'json' &&
        !this.hasHeader(resolved.headers, 'Content-Type') &&
        !this.hasHeader(resolved.headers, 'content-type')
      ) {
        config.headers = {
          ...config.headers,
          'Content-Type': 'application/json',
        };
      }
    }

    return config;
  }

  /**
   * 检查 headers 中是否存在指定 key（不区分大小写）
   */
  private hasHeader(
    headers: Record<string, string>,
    targetKey: string,
  ): boolean {
    const target = targetKey.toLowerCase();
    return Object.keys(headers).some((k) => k.toLowerCase() === target);
  }

  /**
   * 标准化 axios 响应为 HttpNodeOutput
   */
  private normalizeResponse(response: AxiosResponse): HttpNodeOutput {
    // 提取 headers（axios 返回的 headers 是对象，key 都是小写）
    const headers: Record<string, string> = {};
    if (response.headers && typeof response.headers === 'object') {
      for (const [key, value] of Object.entries(response.headers)) {
        if (typeof value === 'string') {
          headers[key] = value;
        } else if (Array.isArray(value)) {
          headers[key] = value.join(', ');
        }
      }
    }

    return {
      status: response.status ?? 0,
      headers,
      body: response.data !== undefined ? response.data : null,
    };
  }
}
