import { Injectable, Logger } from '@nestjs/common';
import type {
  WebSearchFreshness,
  WebSearchItem,
  WebSearchOptions,
  WebSearchProvider,
  WebSearchResponse,
} from './web-search.types';

/**
 * WebSearchService —— 联网搜索的 provider 抽象层。
 *
 * 为什么单独一层、不直接写在工具里：
 *   1. 搜索源会换（博查 / Tavily / 以后可能加 Bing、SerpAPI），工具只该关心
 *      「查什么、返回什么」，不该关心某家 API 的字段名；
 *   2. 归一化放在这里，换源时 `web-search.tool.ts` 与 Prompt 都不用动；
 *   3. 工具返回值会进模型上下文，长度必须在这一层就裁好。
 *
 * 配置（环境变量，缺省即不启用）：
 *   WEB_SEARCH_PROVIDER   bocha | tavily，留空则按「已配置 Key」自动选
 *   BOCHA_API_KEY         博查 Key（open.bochaai.com）
 *   TAVILY_API_KEY        Tavily Key（tavily.com）
 *   WEB_SEARCH_TIMEOUT_MS 单次请求超时，默认 15000
 *   WEB_SEARCH_MAX_RESULTS 默认返回条数，默认 6
 */
@Injectable()
export class WebSearchService {
  private readonly logger = new Logger(WebSearchService.name);

  private readonly provider: WebSearchProvider | null;
  private readonly keys: Record<WebSearchProvider, string>;
  private readonly timeoutMs: number;
  private readonly defaultMaxResults: number;

  constructor() {
    this.keys = {
      bocha: (process.env.BOCHA_API_KEY ?? '').trim(),
      tavily: (process.env.TAVILY_API_KEY ?? '').trim(),
    };

    const timeout = Number(process.env.WEB_SEARCH_TIMEOUT_MS ?? 15000);
    this.timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 15000;

    const maxResults = Number(process.env.WEB_SEARCH_MAX_RESULTS ?? 6);
    this.defaultMaxResults =
      Number.isFinite(maxResults) && maxResults > 0
        ? Math.min(Math.floor(maxResults), 10)
        : 6;

    this.provider = this.resolveProvider();

    if (this.provider) {
      this.logger.log(`联网搜索已启用：${this.provider}`);
    } else {
      // 不报错：没配 Key 只是没有这个工具，属于正常状态
      this.logger.log(
        '联网搜索未启用（未配置 BOCHA_API_KEY / TAVILY_API_KEY），web_search 工具不会暴露给模型',
      );
    }
  }

  /**
   * 决定用哪家：
   *   1. 显式配了 WEB_SEARCH_PROVIDER 且该家有 Key → 用它
   *   2. 显式配了但没 Key，而另一家有 → 降级到另一家（并告警）
   *   3. 都没显式配 → 优先博查（国内延迟低），其次 Tavily
   */
  private resolveProvider(): WebSearchProvider | null {
    const requested = (process.env.WEB_SEARCH_PROVIDER ?? '')
      .trim()
      .toLowerCase();

    // 一个 Key 都没有 = 功能未启用，属于正常状态，不该刷警告
    // （.env 里 WEB_SEARCH_PROVIDER 有默认值，不能据此判断用户「配错了」）
    if (!this.keys.bocha && !this.keys.tavily) return null;

    if (requested === 'bocha' || requested === 'tavily') {
      if (this.keys[requested]) return requested;
      const other: WebSearchProvider = requested === 'bocha' ? 'tavily' : 'bocha';
      this.logger.warn(
        `WEB_SEARCH_PROVIDER=${requested} 但未配置对应 Key，降级为 ${other}`,
      );
      return other;
    }

    if (requested) {
      this.logger.warn(
        `WEB_SEARCH_PROVIDER="${requested}" 不是受支持的值（bocha / tavily），改为自动选择`,
      );
    }

    if (this.keys.bocha) return 'bocha';
    if (this.keys.tavily) return 'tavily';
    return null;
  }

  /** 是否可用（工具据此决定要不要暴露给模型） */
  isEnabled(): boolean {
    return this.provider !== null;
  }

  getProvider(): WebSearchProvider | null {
    return this.provider;
  }

  getDefaultMaxResults(): number {
    return this.defaultMaxResults;
  }

  async search(options: WebSearchOptions): Promise<WebSearchResponse> {
    const provider = this.provider;
    if (!provider) {
      throw new Error('联网搜索未配置：请设置 BOCHA_API_KEY 或 TAVILY_API_KEY');
    }

    const query = options.query.trim();
    if (!query) throw new Error('搜索关键词不能为空');

    const maxResults = Math.min(
      Math.max(Math.floor(options.maxResults ?? this.defaultMaxResults), 1),
      10,
    );
    const freshness: WebSearchFreshness = options.freshness ?? 'all';

    const items =
      provider === 'bocha'
        ? await this.searchBocha(query, maxResults, freshness)
        : await this.searchTavily(query, maxResults, freshness);

    return { provider, query, items: items.slice(0, maxResults) };
  }

  // ===========================================================================
  // 博查：POST https://api.bochaai.com/v1/web-search
  //   请求 { query, count, freshness, summary }
  //   响应 { code, data: { webPages: { value: [...] } } }（SDK 包装）
  //        或直接 { webPages: { value: [...] } }
  // ===========================================================================
  private async searchBocha(
    query: string,
    maxResults: number,
    freshness: WebSearchFreshness,
  ): Promise<WebSearchItem[]> {
    const freshnessMap: Record<WebSearchFreshness, string> = {
      day: 'oneDay',
      week: 'oneWeek',
      month: 'oneMonth',
      year: 'oneYear',
      all: 'noLimit',
    };

    const body = await this.postJson(
      'https://api.bochaai.com/v1/web-search',
      {
        Authorization: `Bearer ${this.keys.bocha}`,
      },
      {
        query,
        count: maxResults,
        freshness: freshnessMap[freshness],
        // 让博查额外生成一段摘要，长文检索质量明显更好
        summary: true,
      },
      '博查',
    );

    const payload = (body as { data?: unknown }).data ?? body;

    // 博查有时用 HTTP 200 + 体内 code 表示失败（SDK 风格），不能只看 response.ok
    const bodyCode = (body as { code?: unknown }).code;
    if (bodyCode !== undefined && Number(bodyCode) !== 200) {
      const msg = (body as { msg?: unknown; message?: unknown }).msg ??
        (body as { message?: unknown }).message ??
        '未知错误';
      throw new Error(`博查 搜索失败（code=${String(bodyCode)}）：${String(msg)}`);
    }

    const webPages = (payload as { webPages?: { value?: unknown } }).webPages;
    const raw = Array.isArray(webPages?.value) ? webPages.value : [];

    return raw
      .map((item) => {
        const row = item as Record<string, unknown>;
        return {
          title: this.clean(String(row.name ?? row.title ?? '')),
          url: String(row.url ?? ''),
          // summary 比 snippet 长但信息密度高，优先用；过长会被 format 阶段裁剪
          snippet: this.clean(
            String(row.summary ?? row.snippet ?? row.description ?? ''),
          ),
          siteName: row.siteName ? this.clean(String(row.siteName)) : undefined,
          publishedAt: row.datePublished
            ? String(row.datePublished)
            : undefined,
        };
      })
      .filter((item) => item.url && (item.title || item.snippet));
  }

  // ===========================================================================
  // Tavily：POST https://api.tavily.com/search
  //   请求 { query, max_results, search_depth, topic, time_range }
  //   响应 { results: [{ title, url, content, score, published_date }] }
  // ===========================================================================
  private async searchTavily(
    query: string,
    maxResults: number,
    freshness: WebSearchFreshness,
  ): Promise<WebSearchItem[]> {
    const timeRange =
      freshness === 'all' ? undefined : (freshness as 'day' | 'week' | 'month' | 'year');

    const body = await this.postJson(
      'https://api.tavily.com/search',
      {
        Authorization: `Bearer ${this.keys.tavily}`,
      },
      {
        query,
        max_results: maxResults,
        // basic 在相关性与延迟之间比较平衡；advanced 要 2 倍 credit
        search_depth: 'basic',
        // 时效性查询走 news，能拿到发布时间且排序更偏新
        topic: freshness === 'day' || freshness === 'week' ? 'news' : 'general',
        ...(timeRange ? { time_range: timeRange } : {}),
        include_published_date: true,
      },
      'Tavily',
    );

    const results = (body as { results?: unknown }).results;
    const raw = Array.isArray(results) ? results : [];

    return raw
      .map((item) => {
        const row = item as Record<string, unknown>;
        return {
          title: this.clean(String(row.title ?? '')),
          url: String(row.url ?? ''),
          snippet: this.clean(String(row.content ?? row.snippet ?? '')),
          publishedAt: row.published_date
            ? String(row.published_date)
            : undefined,
        };
      })
      .filter((item) => item.url && (item.title || item.snippet));
  }

  // ===========================================================================
  // 公共 HTTP
  // ===========================================================================

  /** 带超时的 JSON POST；错误信息里带上 provider 名，便于用户定位是哪家的问题 */
  private async postJson(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    label: string,
  ): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const detail = this.clean(text).slice(0, 200);
        // 401/403 基本都是 Key 的问题，单独提示，比原样抛 400 体有用
        if (response.status === 401 || response.status === 403) {
          throw new Error(`${label} 鉴权失败（${response.status}）：请检查 API Key 是否有效`);
        }
        if (response.status === 429) {
          throw new Error(`${label} 触发限流（429）：请稍后再试或检查套餐额度`);
        }
        throw new Error(
          `${label} 返回 ${response.status}${detail ? `：${detail}` : ''}`,
        );
      }

      return (await response.json()) as unknown;
    } catch (err) {
      if (timedOut) {
        throw new Error(`${label} 搜索超时（${this.timeoutMs}ms）`);
      }
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  /** 压掉换行与连续空白：结果要拼进模型上下文，格式干净点更省 token */
  private clean(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }
}
