import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { VOICE_IDS } from '../persona/persona.prompt';
import { DEFAULT_TTS_VOICE, TtsService } from './tts.service';

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
 * 仅登录用户可用；voice 必须是服务端白名单（VOICE_IDS），否则回落默认音色。
 * 音频用 base64 包在 JSON 里返回，便于桌宠复用既有的 JSON 请求通道。
 */
@Controller('tts')
@UseGuards(JwtAuthGuard)
export class TtsController {
  constructor(private readonly tts: TtsService) {}

  @Post('synthesize')
  async synthesize(@Body() body: SynthesizeBody) {
    const voice =
      body.voice && VOICE_IDS.includes(body.voice)
        ? body.voice
        : DEFAULT_TTS_VOICE;

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
