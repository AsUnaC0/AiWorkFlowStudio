import { PersonaService } from './persona.service';
import {
  DEFAULT_PERSONA_PROMPT,
  LEGACY_PERSONA_PROMPTS,
} from './persona.prompt';

/**
 * PersonaService 单测（只测「默认人格升级」这一条路径）。
 *
 * 为什么单独测它：默认人格是**服务端资产**，用户只改语音/频率时前端也会把当时的
 * 默认文本一并落库。如果升级逻辑误判，就会把用户自己写的人格覆盖掉 —— 这是不可逆的。
 * 因此三条边界必须钉住：无记录用默认、旧默认可升级、用户自定义绝不碰。
 */
describe('PersonaService 默认人格升级', () => {
  const agentId = 'agent-1';

  function createService(personaRecord: Record<string, unknown> | null) {
    const update = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...(personaRecord as object),
      ...data,
    }));
    const prisma = {
      agentPersona: {
        findUnique: jest.fn(async () => personaRecord),
        update,
      },
    };
    const service = new PersonaService(prisma as never);
    return { service, update };
  }

  function baseRecord(systemPrompt: string) {
    return {
      id: 'p1',
      agentId,
      name: '小蝶',
      tags: ['仿真'],
      systemPrompt,
      avatar: null,
      voiceEnabled: true,
      voiceId: 'zh-CN-XiaoyiNeural',
      speechRate: 1,
      pitch: 1,
      desktopPetEnabled: false,
      proactiveChatEnabled: false,
      proactiveChatFrequency: 'low',
      screenPerceptionEnabled: false,
      screenPerceptionInterval: 60,
      personaVersion: 1,
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    };
  }

  it('没有记录时返回内存默认人格（含最新提示词）', async () => {
    const { service, update } = createService(null);
    const persona = await service.resolveForAgent(agentId);

    expect(persona.persisted).toBe(false);
    expect(persona.systemPrompt).toBe(DEFAULT_PERSONA_PROMPT);
    expect(update).not.toHaveBeenCalled();
  });

  it.each(LEGACY_PERSONA_PROMPTS.map((p, i) => [i, p]))(
    '存量记录仍是旧版文本（第 %i 版）时，自动升级为最新默认并自增版本',
    async (_index, legacy) => {
      const { service, update } = createService(baseRecord(legacy));

      const persona = await service.resolveForAgent(agentId);

      expect(update).toHaveBeenCalledTimes(1);
      expect(persona.systemPrompt).toBe(DEFAULT_PERSONA_PROMPT);
      expect(persona.personaVersion).toBe(2);
    },
  );

  it('用户自己改过的人格文本绝不被覆盖', async () => {
    const custom = '你是我的私人助理，说话要非常正式，不要卖萌。';
    const { service, update } = createService(baseRecord(custom));

    const persona = await service.resolveForAgent(agentId);

    expect(update).not.toHaveBeenCalled();
    expect(persona.systemPrompt).toBe(custom);
    expect(persona.personaVersion).toBe(1);
  });

  it('空白人格文本不算旧默认值（不触发写库）', async () => {
    const { service, update } = createService(baseRecord('   '));
    await service.resolveForAgent(agentId);
    expect(update).not.toHaveBeenCalled();
  });
});
