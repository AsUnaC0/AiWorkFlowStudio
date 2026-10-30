/** 联网搜索提供方 */
export type WebSearchProvider = 'bocha' | 'tavily';

/** 时间范围过滤（统一语义，各 provider 自行映射） */
export type WebSearchFreshness = 'day' | 'week' | 'month' | 'year' | 'all';

export interface WebSearchOptions {
  query: string;
  /** 期望返回条数（会被 provider 上限截断） */
  maxResults?: number;
  /** 只取某个时间范围内的结果 */
  freshness?: WebSearchFreshness;
}

/** 归一化后的单条搜索结果 */
export interface WebSearchItem {
  title: string;
  url: string;
  snippet: string;
  siteName?: string;
  publishedAt?: string;
}

export interface WebSearchResponse {
  provider: WebSearchProvider;
  query: string;
  items: WebSearchItem[];
}
