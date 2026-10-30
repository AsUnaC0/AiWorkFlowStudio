import { Injectable, Logger } from '@nestjs/common';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

export interface SynthesizeOptions {
  text: string;
  voice?: string;
  /** 语速：1.0 为正常，0.5 为半速（也可传 '+50%' 这类相对值）。仅 Edge 引擎生效 */
  rate?: number | string;
  /** 音调：'+0Hz' / '+2st' / '+50%'。仅 Edge 引擎生效 */
  pitch?: string;
}

export const DEFAULT_TTS_VOICE = 'zh-CN-XiaoyiNeural';

/** BreezeBlue 音色 id 前缀（形如 voc_xeh3w54cqvnp） */
const BREEZE_VOICE_PREFIX = 'voc_';

/**
 * TtsService —— 把文本合成成 mp3 音频。
 *
 * 双引擎，用 voice 前缀区分：
 *   1. **Edge TTS**（`msedge-tts`，无需密钥）—— 默认。voice 形如 `zh-CN-XiaoyiNeural`
 *   2. **BreezeBlue**（ElevenLabs 兼容，需 `BREEZE_API_KEY`）—— voice 形如 `voc_xxx`
 *
 * 为什么按前缀分而不是加一个 provider 开关：
 *   老音色（Edge 白名单）与 BreezeBlue 音色 id 命名空间天然不同，
 *   用户只要把 voiceId 改成 `voc_xxx` 就自动切到 BreezeBlue，不需要额外配置项，
 *   也不会影响已有的 Edge 音色。
 *
 * 环境变量：
 *   BREEZE_API_KEY          BreezeBlue 密钥（brz_xxx）；不配则 BreezeBlue 音色不可用
 *   BREEZE_BASE_URL         默认 https://api.breeze.blue
 *   BREEZE_MODEL_ID         默认 breeze-tts-2
 *   BREEZE_OUTPUT_FORMAT    默认 mp3_24000_128
 *   BREEZE_TIMEOUT_MS       默认 30000
 *   BREEZE_DEFAULT_VOICE_ID 未指定音色时的 BreezeBlue 默认音色（可选）
 */
@Injectable()
export class TtsService {
  private readonly logger = new Logger(TtsService.name);

  private readonly breezeKey: string;
  private readonly breezeBase: string;
  private readonly breezeModel: string;
  private readonly breezeFormat: string;
  private readonly breezeTimeoutMs: number;

  constructor() {
    this.breezeKey = (process.env.BREEZE_API_KEY ?? '').trim();
    this.breezeBase = (process.env.BREEZE_BASE_URL ?? 'https://api.breeze.blue')
      .trim()
      .replace(/\/$/, '');
    this.breezeModel = (process.env.BREEZE_MODEL_ID ?? 'breeze-tts-2').trim();
    this.breezeFormat = (
      process.env.BREEZE_OUTPUT_FORMAT ?? 'mp3_24000_128'
    ).trim();

    const timeout = Number(process.env.BREEZE_TIMEOUT_MS ?? 30000);
    this.breezeTimeoutMs =
      Number.isFinite(timeout) && timeout > 0 ? timeout : 30000;

    if (this.breezeKey) {
      this.logger.log(
        `[TTS] BreezeBlue 已启用（model=${this.breezeModel}, format=${this.breezeFormat}）`,
      );
    }
  }

  /** 是否配置了 BreezeBlue 密钥 */
  isBreezeEnabled(): boolean {
    return this.breezeKey.length > 0;
  }

  /** 该 voice 是否是 BreezeBlue 音色（`voc_` 前缀） */
  isBreezeVoice(voice?: string): boolean {
    return (voice ?? '').toLowerCase().startsWith(BREEZE_VOICE_PREFIX);
  }

  /** 未指定音色时的默认值：配了 Breeze 默认音色则用它，否则用 Edge 默认 */
  getDefaultVoice(): string {
    const breezeDefault = (process.env.BREEZE_DEFAULT_VOICE_ID ?? '').trim();
    if (this.isBreezeEnabled() && breezeDefault) return breezeDefault;
    return DEFAULT_TTS_VOICE;
  }

  async synthesize({
    text,
    voice = this.getDefaultVoice(),
    rate = 1.0,
    pitch = '+0Hz',
  }: SynthesizeOptions): Promise<Buffer> {
    const clean = (text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return Buffer.alloc(0);

    // BreezeBlue 音色 → 走 Breeze API（必须配密钥）
    if (this.isBreezeVoice(voice)) {
      if (!this.isBreezeEnabled()) {
        throw new Error(
          '未配置 BREEZE_API_KEY，无法使用 BreezeBlue 音色（voc_xxx）',
        );
      }
      return this.synthesizeBreeze(clean, voice);
    }

    // 其余 → Edge TTS（原逻辑：长文本切句后逐段合成再拼接）
    const pieces = splitSentences(clean);
    const buffers: Buffer[] = [];
    for (const piece of pieces) {
      try {
        const buf = await this.synthesizeEdgePiece(piece, voice, rate, pitch);
        if (buf.length > 0) buffers.push(buf);
      } catch (e) {
        this.logger.warn(
          `TTS 合成失败（片段已跳过）：${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return Buffer.concat(buffers);
  }

  // ===========================================================================
  // BreezeBlue（ElevenLabs 兼容）
  //   POST {base}/v1/text-to-speech/{voice_id}?output_format=mp3_24000_128
  //   header: xi-api-key
  //   body:   { text, model_id }
  //   resp:   200 audio/mpeg 二进制
  // ===========================================================================

  private async synthesizeBreeze(
    text: string,
    voiceId: string,
  ): Promise<Buffer> {
    // Breeze 单次默认上限 1000 字符，按 900 切片后逐段合成再拼接
    const pieces = splitByLength(text, 900);
    const buffers: Buffer[] = [];
    for (const piece of pieces) {
      const buf = await this.synthesizeBreezePiece(piece, voiceId);
      if (buf.length > 0) buffers.push(buf);
    }
    return Buffer.concat(buffers);
  }

  private async synthesizeBreezePiece(
    text: string,
    voiceId: string,
  ): Promise<Buffer> {
    const url =
      `${this.breezeBase}/v1/text-to-speech/${encodeURIComponent(voiceId)}` +
      `?output_format=${encodeURIComponent(this.breezeFormat)}`;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.breezeTimeoutMs);

    try {
      const body: Record<string, unknown> = { text };
      if (this.breezeModel) body.model_id = this.breezeModel;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': this.breezeKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const raw = await response.text().catch(() => '');
        throw new Error(this.describeBreezeError(response.status, raw));
      }

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err) {
      if (timedOut) {
        throw new Error(`BreezeBlue 合成超时（${this.breezeTimeoutMs}ms）`);
      }
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  /** 把 Breeze 的错误体翻译成人能看懂的一句话（401/402/404/429 单独提示） */
  private describeBreezeError(status: number, raw: string): string {
    let detail = raw.trim().slice(0, 300);
    try {
      const parsed = JSON.parse(raw) as {
        detail?: unknown;
        message?: unknown;
      };
      const d = parsed.detail;
      if (typeof d === 'string') {
        detail = d;
      } else if (
        d &&
        typeof d === 'object' &&
        typeof (d as { message?: unknown }).message === 'string'
      ) {
        detail = (d as { message: string }).message;
      } else if (typeof parsed.message === 'string') {
        detail = parsed.message;
      }
    } catch {
      /* 非 JSON，保留原文 */
    }

    if (status === 401) {
      return 'BreezeBlue 鉴权失败（401）：请检查 BREEZE_API_KEY 是否有效';
    }
    if (status === 402) {
      return `BreezeBlue 额度不足（402）：${detail}`;
    }
    if (status === 404) {
      return `BreezeBlue 音色不存在（404）：请检查 voiceId 是否正确`;
    }
    if (status === 429) {
      return `BreezeBlue 触发限流（429）：${detail}`;
    }
    return `BreezeBlue 返回 ${status}${detail ? `：${detail}` : ''}`;
  }

  // ===========================================================================
  // Edge TTS
  // ===========================================================================

  /** 单段合成：每次新建实例、用完即关，避免长连接状态互相污染 */
  private async synthesizeEdgePiece(
    text: string,
    voice: string,
    rate: number | string,
    pitch: string,
  ): Promise<Buffer> {
    const tts = new MsEdgeTTS();
    try {
      await tts.setMetadata(
        voice,
        OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
      );
      const { audioStream } = tts.toStream(text, { rate, pitch });
      const chunks: Buffer[] = [];
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
}

/**
 * 把长文本切成 ~max 字符以内的片段（优先在句末标点处断开）。
 * 用于 BreezeBlue 单次 1000 字符上限。
 */
function splitByLength(text: string, max: number): string[] {
  if (text.length <= max) return [text];

  const parts = text.split(/([。！？!?\n])/);
  const merged: string[] = [];
  let cur = '';
  for (const p of parts) {
    cur += p;
    if (cur.length >= max) {
      const trimmed = cur.trim();
      if (trimmed) merged.push(trimmed);
      cur = '';
    }
  }
  const tail = cur.trim();
  if (tail) merged.push(tail);
  return merged.length ? merged : [text];
}

/**
 * 把长文本切成 ~800 字以内的片段。
 *
 * 中英文句末标点 + 换行都算断句点，并保留标点；不足阈值则整段返回。
 * 不用 lookbehind（老 Node 不支持），改用「带分隔符的 split + 累加」即可。
 */
function splitSentences(text: string): string[] {
  if (text.length <= 1000) return [text];

  const parts = text.split(/([。！？!?\n])/);
  const merged: string[] = [];
  let cur = '';
  for (const p of parts) {
    cur += p;
    if (cur.length >= 800) {
      const trimmed = cur.trim();
      if (trimmed) merged.push(trimmed);
      cur = '';
    }
  }
  const tail = cur.trim();
  if (tail) merged.push(tail);
  return merged.length ? merged : [text];
}
