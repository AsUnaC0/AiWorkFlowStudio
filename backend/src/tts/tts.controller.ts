import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { VOICE_IDS } from '../persona/persona.prompt';
import { TtsService } from './tts.service';

interface SynthesizeBody {
  text?: string;
  voice?: string;
  rate?: number | string;
  pitch?: string;
}

/**
 * TTS 代理接口（桌宠兜底用）。
 *
 *   POST /api/tts/synthesize  body: { text, voice?, rate?, pitch? }
 *   → { format: 'mp3', audio: base64 }
 *
 * 仅登录用户可用。voice 解析规则：
 *   - `voc_xxx`（BreezeBlue 音色）→ 原样透传，由 TtsService 走 Breeze API
 *   - Edge 白名单（VOICE_IDS）  → 走 Edge TTS
 *   - 其他 / 空                 → 回落到默认音色（配了 Breeze 默认则用它）
 *
 * 音频用 base64 包在 JSON 里返回，便于桌宠复用既有的 JSON 请求通道。
 */
@Controller('tts')
@UseGuards(JwtAuthGuard)
export class TtsController {
  constructor(private readonly tts: TtsService) {}

  @Post('synthesize')
  async synthesize(@Body() body: SynthesizeBody) {
    const requested = (body.voice ?? '').trim();

    const voice =
      requested &&
      (this.tts.isBreezeVoice(requested) || VOICE_IDS.includes(requested))
        ? requested
        : this.tts.getDefaultVoice();

    const audio = await this.tts.synthesize({
      text: body.text || '',
      voice,
      rate: body.rate,
      pitch: body.pitch,
    });

    return {
      format: 'mp3',
      audio: audio.toString('base64'),
    };
  }
}
