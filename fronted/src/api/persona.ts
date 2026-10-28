import { request } from "@/utils/request";

// ===========================================================================
// 人格配置（仅平台默认助理）
//
// 注意：Agent.name 固定是「平台助理」（系统标识），人格名是另一个字段。
// 界面上要展示的是 persona.name。
// ===========================================================================

export interface PersonaProfile {
  name: string;
  tags: string[];
  systemPrompt: string;
  avatar: string | null;

  voiceEnabled: boolean;
  voiceId: string;
  speechRate: number;
  pitch: number;

  desktopPetEnabled: boolean;
  proactiveChatEnabled: boolean;
  /** off / low / medium / high */
  proactiveChatFrequency: string;

  screenPerceptionEnabled: boolean;
  screenPerceptionInterval: number;

  personaVersion: number;
  /** false 表示还没保存过，当前用的是服务端默认值 */
  persisted: boolean;
  updatedAt: string | null;
}

export interface UpdatePersonaPayload {
  name?: string;
  tags?: string[];
  systemPrompt?: string;
  avatar?: string;
  voiceEnabled?: boolean;
  voiceId?: string;
  speechRate?: number;
  pitch?: number;
  desktopPetEnabled?: boolean;
  proactiveChatEnabled?: boolean;
  proactiveChatFrequency?: string;
  screenPerceptionEnabled?: boolean;
  screenPerceptionInterval?: number;
}

export interface VoiceOption {
  id: string;
  label: string;
  description: string;
}

export interface FrequencyOption {
  value: string;
  label: string;
  minPerHour: number;
  maxPerHour: number;
}

export interface PersonaOptions {
  voices: VoiceOption[];
  frequencies: FrequencyOption[];
  limits: { nameMax: number; tagMax: number; tagsMax: number; promptMax: number };
}

export const getPersona = (agentId: string): Promise<PersonaProfile> =>
  request.get(`/agents/${agentId}/persona`);

export const updatePersona = (
  agentId: string,
  data: UpdatePersonaPayload,
): Promise<PersonaProfile> => request.put(`/agents/${agentId}/persona`, data);

export const resetPersona = (agentId: string): Promise<PersonaProfile> =>
  request.post(`/agents/${agentId}/persona/reset`);

export const getPersonaOptions = (agentId: string): Promise<PersonaOptions> =>
  request.get(`/agents/${agentId}/persona/options`);
