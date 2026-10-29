/* eslint-disable */
/**
 * reasoning 通道验证脚本（一次性，跑完可删）
 *
 * 用真实 HTTP 假服务端验证两个 Provider 的 reasoning 解析：
 *   - OpenAI 兼容：reasoning_content（非流式 / 流式 / 带工具）
 *   - Ollama：message.thinking（非流式 / 流式 NDJSON）
 *
 * 运行：cd backend && npx ts-node --transpile-only ../.workbuddy-ai/tmp/reasoning-check/check.ts
 */
import * as http from 'http';
import { OpenAICompatibleProvider } from '../../../backend/src/ai/providers/openai-compatible.provider';
import { OllamaProvider } from '../../../backend/src/ai/providers/ollama.provider';
import { createProvider } from '../../../backend/src/ai/providers/provider.factory';

const OPENAI_REASONING = '先看用户问的是加法。3+5=8。';
const OLLAMA_THINKING = '先拆题：一打=12个，两打=24个。';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.log(`  ❌ ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}

function startServer(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const isOllama = (req.url ?? '').startsWith('/api/chat');
      const payload = body ? JSON.parse(body) : {};

      if (isOllama) {
        res.setHeader('Content-Type', 'application/x-ndjson');
        if (payload.stream) {
          const lines = [
            { message: { role: 'assistant', thinking: '先拆题：' }, done: false },
            { message: { thinking: '一打=12个，两打=24个。' }, done: false },
            { message: { content: '一共 24 个。' }, done: false },
            { message: { content: '' }, done: true },
          ];
          res.end(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            message: { role: 'assistant', thinking: OLLAMA_THINKING, content: '一共 24 个。' },
            eval_count: 5,
            prompt_eval_count: 7,
          }),
        );
        return;
      }

      // OpenAI 兼容
      if (payload.stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        const chunks = [
          { choices: [{ delta: { reasoning_content: '先看用户问的是加法。' } }] },
          { choices: [{ delta: { reasoning_content: '3+5=8。' } }] },
          { choices: [{ delta: { content: '等于 ' } }] },
          { choices: [{ delta: { content: '8。' } }] },
        ];
        const sse =
          chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') +
          'data: [DONE]\n\n';
        res.end(sse);
        return;
      }

      res.setHeader('Content-Type', 'application/json');
      // model === 'plain' 模拟「不支持思考的普通模型」：不返回任何推理字段
      const isPlain = payload.model === 'plain';
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: '等于 8。',
                ...(isPlain ? {} : { reasoning_content: OPENAI_REASONING }),
                ...(payload.tools
                  ? {
                      tool_calls: [
                        {
                          id: 'call_1',
                          type: 'function',
                          function: { name: 'calc', arguments: '{"a":3,"b":5}' },
                        },
                      ],
                    }
                  : {}),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }),
      );
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
      });
    });
  });
}

(async () => {
  const { url, close } = await startServer();
  const options = { model: 'test-model' };

  try {
    console.log('\n[1] OpenAI 兼容 · 非流式 chat');
    const oa = new OpenAICompatibleProvider(url, 'sk-test', 'deepseek');
    const r1 = await oa.chat([{ role: 'user', content: '3+5' }], options);
    check('content 正确', r1.content === '等于 8。', r1.content);
    check('reasoning 解析正确', r1.reasoning === OPENAI_REASONING, r1.reasoning);
    check('name 保留为 deepseek', oa.name === 'deepseek', oa.name);

    console.log('\n[2] OpenAI 兼容 · 流式 streamChat（reasoning 与 content 分流）');
    const reasoningDeltas: string[] = [];
    const contentDeltas: string[] = [];
    for await (const chunk of oa.streamChat([{ role: 'user', content: '3+5' }], options)) {
      if (chunk.type === 'reasoning') reasoningDeltas.push(chunk.text);
      else contentDeltas.push(chunk.text);
    }
    check('推理走 reasoning 通道', reasoningDeltas.join('') === OPENAI_REASONING, reasoningDeltas);
    check('正文走 content 通道', contentDeltas.join('') === '等于 8。', contentDeltas);
    check('正文里不含推理内容', !contentDeltas.join('').includes('加法'), contentDeltas);

    console.log('\n[3] OpenAI 兼容 · chatWithTools');
    const r3 = await oa.chatWithTools(
      [{ role: 'user', content: '3+5' }],
      options,
      [
        {
          type: 'function',
          function: { name: 'calc', description: '算数', parameters: { type: 'object', properties: {} } },
        },
      ],
    );
    check('reasoning 解析正确', r3.reasoning === OPENAI_REASONING, r3.reasoning);
    check('tool_calls 仍正常', r3.toolCalls.length === 1 && r3.toolCalls[0].function.name === 'calc', r3.toolCalls);

    console.log('\n[4] Ollama · 非流式 chat');
    const ol = new OllamaProvider(url);
    const r4 = await ol.chat([{ role: 'user', content: '两打是多少' }], options);
    check('content 正确', r4.content === '一共 24 个。', r4.content);
    check('reasoning 来自 message.thinking', r4.reasoning === OLLAMA_THINKING, r4.reasoning);

    console.log('\n[5] Ollama · 流式 streamChat（NDJSON）');
    const olReasoning: string[] = [];
    const olContent: string[] = [];
    for await (const chunk of ol.streamChat([{ role: 'user', content: '两打' }], options)) {
      if (chunk.type === 'reasoning') olReasoning.push(chunk.text);
      else olContent.push(chunk.text);
    }
    check('thinking 走 reasoning 通道', olReasoning.join('') === OLLAMA_THINKING, olReasoning);
    check('正文走 content 通道', olContent.join('') === '一共 24 个。', olContent);

    console.log('\n[6] 无推理的普通模型不受影响');
    const plain = new OpenAICompatibleProvider(url, 'sk-test', 'openai');
    const r6 = await plain.chat([{ role: 'user', content: 'hi' }], {
      model: 'plain',
    });
    check('reasoning 缺省时不返回该字段', !('reasoning' in r6), Object.keys(r6));

    // ---------------------------------------------------------------------
    // [7] createProvider：openai / deepseek 合并成同一个 case 后，行为必须不变
    //     用 fetch 拦截抓「实际请求地址」，验证默认 baseUrl 与 name 都还对
    // ---------------------------------------------------------------------
    console.log('\n[7] createProvider（openai / deepseek 合并分支）');
    const realFetch = globalThis.fetch;
    let capturedUrl = '';
    globalThis.fetch = (async (input: any) => {
      capturedUrl = String(input);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      const cases: Array<[string, string, string]> = [
        ['openai', 'https://api.openai.com/v1/chat/completions', 'openai'],
        ['deepseek', 'https://api.deepseek.com/v1/chat/completions', 'deepseek'],
      ];
      for (const [type, expectUrl, expectName] of cases) {
        const p = createProvider({
          provider: type as any,
          baseUrl: null, // ← 不传 baseUrl，走 DEFAULT_BASE_URL 兜底
          apiKey: 'sk-test',
        });
        check(`${type} · name = ${expectName}`, p.name === expectName, p.name);
        capturedUrl = '';
        await p.chat([{ role: 'user', content: 'hi' }], options);
        check(`${type} · 默认 baseUrl 正确`, capturedUrl === expectUrl, capturedUrl);
      }

      // 显式 baseUrl 必须覆盖默认值
      const custom = createProvider({
        provider: 'deepseek',
        baseUrl: 'https://my-gateway.example.com/v1',
        apiKey: 'sk-test',
      });
      capturedUrl = '';
      await custom.chat([{ role: 'user', content: 'hi' }], options);
      check(
        'deepseek · 显式 baseUrl 覆盖默认值',
        capturedUrl === 'https://my-gateway.example.com/v1/chat/completions',
        capturedUrl,
      );

      // openai-compatible 仍然必须要求 baseUrl
      let threw = false;
      try {
        createProvider({ provider: 'openai-compatible', baseUrl: '', apiKey: 'k' });
      } catch {
        threw = true;
      }
      check('openai-compatible · 缺 baseUrl 仍然抛错', threw);
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    close();
  }

  console.log(`\n${failures === 0 ? '全部通过' : `有 ${failures} 项失败`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
