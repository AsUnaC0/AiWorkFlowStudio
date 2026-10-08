import { request } from "@/utils/request";
import type {
  CreateSkillRequest,
  Skill,
  UpdateSkillRequest,
} from "@/types/skill";

// ===========================================================================
// Skills —— 独立资源，owner 权限模型
// ===========================================================================

/** 创建 Skill */
export const createSkill = (data: CreateSkillRequest): Promise<Skill> => {
  return request.post("/skills", data);
};

/** 获取当前用户的全部 Skills */
export const getSkills = (): Promise<Skill[]> => {
  return request.get("/skills");
};

/** 获取单个 Skill */
export const getSkill = (skillId: string): Promise<Skill> => {
  return request.get(`/skills/${skillId}`);
};

/** 更新 Skill */
export const updateSkill = (
  skillId: string,
  data: UpdateSkillRequest,
): Promise<Skill> => {
  return request.put(`/skills/${skillId}`, data);
};

/** 删除 Skill */
export const removeSkill = (skillId: string): Promise<Skill> => {
  return request.delete(`/skills/${skillId}`);
};
