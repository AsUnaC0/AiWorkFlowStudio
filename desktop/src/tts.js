'use strict';

/**
 * 小蝶桌宠 —— 本地 Edge TTS 合成（首版本地优先，失败回落后端代理）。
 *
 * 设计（对应需求 §3.3 / §5.3「本地调用优先，失败回落后端代理」）：
 *   1. 优先在本机用 Edge TTS 合成（无需密钥，直接连微软语音服务）。
 *   2. 本地失败一次就进入「冷却」：接下来 1 分钟内直接走后端代理，
 *      避免每条消息都卡一次本地超时（微软服务不通时尤其致命）。
 *   3. 后端代理也失败 → 返回 null，桌宠只出气泡、不出声，绝不影响对话。
 *
 * 为什么放在主进程：渲染进程是 file:// 源、且所有网络都收口在主进程（见 main.js 顶部），
 * 这里合成出的音频再发给渲染进程用 Web Audio 播放。
 *
 * 用 `msedge-tts` 而不是 `edge-tts`：微软当前要求 Sec-MS-GEC v2 令牌，
 * `edge-tts@1.0.x` 只发 v1 会 403；`msedge-tts` 已实现 v2 并能自动校正时钟偏差。
 */

const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const DEFAULT_VOICE = 'zh-CN-XiaoyiNeural';
const ERROR_COOLDOWN_MS = 60 * 1000;

let localBrokenUntil = 0;

async function synthLocal(text, voice) {
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(
      voice || DEFAULT_VOICE,
      OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
    );
    const { audioStream } = tts.toStream(text, { rate: 1.0, pitch: '+0Hz' });
    const chunks = [];
    for await (const chunk of audioStream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } finally {
    try {
      tts.close();
    } catch {
      /* 已经关了 */
    }
  }
}

async function synthRemote(text, voice, api) {
  const data = await api('/tts/synthesize', {
    method: 'POST',
    body: { text, voice: voice || DEFAULT_VOICE },
  });
  if (!data || !data.audio) throw new Error('后端未返回音频');
  return Buffer.from(data.audio, 'base64');
}

/**
 * 合成文本为 mp3 Buffer。
 * 返回 null 表示本次无法发声（不抛错，调用方只当没声音处理）。
 *
 * @param {object} opts
 * @param {string} opts.text    要朗读的文本
 * @param {string} [opts.voice] 音色 id
 * @param {Function} opts.api   主进程的 HTTP 帮助函数（兜底打后端用）
 */
async function synthesize(text, { voice, api } = {}) {
  if (!text || !text.trim()) return null;

  const now = Date.now();
  if (now < localBrokenUntil) {
    // 本地刚失败过，直接走后端，省一次本地超时
    try {
      return await synthRemote(text, voice, api);
    } catch {
      return null;
    }
  }

  try {
    return await synthLocal(text, voice);
  } catch (e) {
    localBrokenUntil = Date.now() + ERROR_COOLDOWN_MS;
    console.warn('[tts] 本地 Edge TTS 失败，回落后端代理：', e.message);
    try {
      return await synthRemote(text, voice, api);
    } catch {
      return null;
    }
  }
}

module.exports = { synthesize, DEFAULT_VOICE };
