#!/usr/bin/env node
/**
 * 极简 MCP stdio server，仅用于验证平台 stdio 传输实现。
 * 实现 initialize / tools/list / tools/call，消息为换行分隔的 JSON。
 */
const readline = require('node:readline');

const TOOLS = [
  {
    name: 'echo',
    description: '原样回显输入',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'env_keys',
    description: '列出子进程可见的环境变量名（用于验证环境隔离）',
    inputSchema: { type: 'object', properties: {} },
  },
];

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  switch (msg.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-mcp', version: '1.0.0' },
        },
      });
      break;
    case 'notifications/initialized':
      break;
    case 'tools/list':
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
      break;
    case 'tools/call': {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      if (name === 'echo') {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: `echo:${args.text}` }] },
        });
      } else if (name === 'env_keys') {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [
              { type: 'text', text: Object.keys(process.env).sort().join(',') },
            ],
          },
        });
      } else {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `unknown tool ${name}` },
        });
      }
      break;
    }
    default:
      if (msg.id !== undefined) {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `method not found: ${msg.method}` },
        });
      }
  }
});
