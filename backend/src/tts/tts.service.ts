import { Injectable, Logger } from '@nestjs/common';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

export interface SynthesizeOptions {
  text: string;
  voice?: string;
  /** 语速：1.0 为正常，0.5 为半速（也可传 '+50%' 这类相对值） */
  rate?: number | string;
  /** 音调：'+0Hz' / '+2st' / '+50%' */
  pitch?: string;
}

export const DEFAULT_TTS_VOICE = 'zh-CN-XiaoyiNeural';

/**
 * TtsService —— 把文本合成成 mp3 音频（Edge TTS / 微软在线语音，无需密钥）。
 *
 * 用 `msedge-tts` 而不是 `edge-tts`：微软当前要求 Sec-MS-GEC **v2** 令牌
 * （CS64 + SHA256 两段式），`edge-tts@1.0.x` 只发 v1，会直接 403；
 * `msedge-tts` 已实现 v2，且带时钟偏差校正，实测可正常合成。
 *
 * 单段文本过长时按句子切片后逐段合成再拼接，既稳又能降低长文本首字延迟。
 * 这是桌宠「本地优先、失败回落后端代理」里的**后端兜底**。
 */
@Injectable()
export class TtsService {
  private readonly logger = new Logger(TtsService.name);

  async synthesize({
    text,
    voice = DEFAULT_TTS_VOICE,
    rate = 1.0,
    pitch = '+0Hz',
  }: SynthesizeOptions): Promise<Buffer> {
    const clean = (text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return Buffer.alloc(0);

    const pieces = splitSentences(clean);
    const buffers: Buffer[] = [];
    for (const piece of pieces) {
      try {
        const buf = await this.synthesizePiece(piece, voice, rate, pitch);
        if (buf.length > 0) buffers.push(buf);
      } catch (e) {
        this.logger.warn(
          `TTS 合成失败（片段已跳过）：${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return Buffer.concat(buffers);
  }

  /** 单段合成：每次新建实例、用完即关，避免长连接状态互相污染 */
  private async synthesizePiece(
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
