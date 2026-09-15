export interface WorkspaceApiItem {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  _count?: {
    members: number;
    workflows?: number;
  };
}

export interface CreateWorkspaceRequest {
  name: string;
}
