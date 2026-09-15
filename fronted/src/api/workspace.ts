import { request } from "@/utils/request";
import type {
  CreateWorkspaceRequest,
  WorkspaceApiItem,
} from "@/types/workspace-api";

export const getWorkspaces = (): Promise<WorkspaceApiItem[]> => {
  return request.get("/workspaces");
};

export const createWorkspace = (
  data: CreateWorkspaceRequest,
): Promise<WorkspaceApiItem> => {
  return request.post("/workspaces", data);
};
