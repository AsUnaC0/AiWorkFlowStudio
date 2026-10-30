/**
 * 联网搜索工具离线校验：把 global.fetch 换成假响应，
 * 核对「请求报文是否正确」+「响应解析/格式化是否正确」+「错误是否可读」。
 * 不联网、不消耗任何 API 额度。
 */
const path = require("path");
const dist = path.join(__dirname, "../../../backend/dist/src");

function loadService(env) {
  // 每次重新加载，让构造函数读到的 env 生效
  Object.keys(require.cache)
    .filter((k) => k.includes("backend/dist/src"))
    .forEach((k) => delete require.cache[k]);
  Object.assign(process.env, env);
  const { WebSearchService } = require(path.join(dist, "web-search/web-search.service.js"));
  const { WebSearchTool } = require(path.join(dist, "agent/tools/web-search.tool.js"));
  const service = new WebSearchService();
  return { service, tool: new WebSearchTool(service) };
}

let captured = null;
function stubFetch(responder) {
  global.fetch = async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return responder(url, init);
  };
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

const longSummary = "阿里".repeat(400); // 800 字，用于验证摘要截断

async function caseBocha() {
  const { tool } = loadService({ WEB_SEARCH_PROVIDER: "bocha", BOCHA_API_KEY: "sk-test", TAVILY_API_KEY: "" });
  stubFetch(() =>
    json({
      code: 200,
      data: {
        webPages: {
          value: [
            { name: "阿里巴巴发布2024年ESG报告", url: "https://a.com/1", siteName: "阿里巴巴集团", summary: longSummary, datePublished: "2024-07-22T00:00:00+08:00" },
            { name: "无摘要条目", url: "https://a.com/2" },
          ],
        },
      },
    }),
  );
  const out = await tool.execute({ query: "阿里 2024 ESG", maxResults: 5, freshness: "month" });
  console.log("=== [1] 博查 · 请求 ===");
  console.log("URL:", captured.url);
  console.log("Auth:", captured.init.headers.Authorization);
  console.log("Body:", JSON.stringify(captured.body));
  console.log("--- 输出（前 900 字）---");
  console.log(out.slice(0, 900));
  console.log("\n摘要是否已截断到 520+省略号:", /阿里(?:阿里){250,}…/.test(out) || out.includes("…"));
  console.log("条数:", (out.match(/^\[\d+\]/gm) || []).length);
}

async function caseTavily() {
  const { tool } = loadService({ WEB_SEARCH_PROVIDER: "tavily", BOCHA_API_KEY: "", TAVILY_API_KEY: "tvly-test" });
  stubFetch(() =>
    json({
      query: "x",
      results: [
        { title: "Result A", url: "https://b.com/1", content: "content a", score: 0.9, published_date: "2026-10-29" },
      ],
    }),
  );
  const out = await tool.execute({ query: "latest release", freshness: "week" });
  console.log("\n=== [2] Tavily · 请求 ===");
  console.log("URL:", captured.url);
  console.log("Body:", JSON.stringify(captured.body));
  console.log("--- 输出 ---");
  console.log(out);
}

async function caseFallback() {
  const { service } = loadService({ WEB_SEARCH_PROVIDER: "bocha", BOCHA_API_KEY: "", TAVILY_API_KEY: "tvly-only" });
  console.log("\n=== [3] 降级 ===");
  console.log("provider=", service.getProvider(), "enabled=", service.isEnabled());
}

async function caseNoKey() {
  const { service, tool } = loadService({ WEB_SEARCH_PROVIDER: "", BOCHA_API_KEY: "", TAVILY_API_KEY: "" });
  console.log("\n=== [4] 无 Key ===");
  console.log("provider=", service.getProvider(), "enabled=", service.isEnabled());
  console.log("工具定义是否暴露:", tool.buildDefinition ? "buildDefinition 存在（是否 push 由 ToolRegistry 按 isAvailable 决定）" : "-");
}

async function caseAuthError() {
  const { tool } = loadService({ WEB_SEARCH_PROVIDER: "bocha", BOCHA_API_KEY: "bad", TAVILY_API_KEY: "" });
  stubFetch(() => json({ code: 401, msg: "invalid api key" }, 401));
  const out = await tool.execute({ query: "test" });
  console.log("\n=== [5] 鉴权失败 ===");
  console.log(out);
}

async function caseTimeout() {
  const { tool } = loadService({ WEB_SEARCH_PROVIDER: "bocha", BOCHA_API_KEY: "k", WEB_SEARCH_TIMEOUT_MS: "60" });
  global.fetch = (url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  const out = await tool.execute({ query: "slow" });
  console.log("\n=== [6] 超时 ===");
  console.log(out);
}

(async () => {
  await caseBocha();
  await caseTavily();
  await caseFallback();
  await caseNoKey();
  await caseAuthError();
  await caseTimeout();
})().catch((e) => {
  console.error("CHECK FAILED:", e);
  process.exit(1);
});
