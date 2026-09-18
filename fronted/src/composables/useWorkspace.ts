import { onMounted, ref } from "vue";
import {
  createWorkspace as createWorkspaceRequest,
  getWorkspaces,
} from "@/api/workspace";
import type { WorkspaceItem } from "@/types/workspace";
import type { WorkspaceApiItem } from "@/types/workspace-api";
import { useRouter } from "vue-router";

export function useWorkspace() {
  const workspaces = ref<WorkspaceItem[]>([]);
  const loading = ref<boolean>(false);
  const errorMessage = ref("");
  const router = useRouter();

  const fetchWorkspaces = async () => {
    loading.value = true;
    errorMessage.value = "";
    try {
      const items = await getWorkspaces();
      workspaces.value = items.map(mapWorkspace);
    } catch {
      errorMessage.value = "Workspace 加载失败，请稍后重试";
    } finally {
      loading.value = false;
    }
  };

  const createWorkspace = async (name: string) => {
    const workspace = await createWorkspaceRequest({ name });
    workspaces.value.unshift(mapWorkspace(workspace));
    return workspace;
  };

  const selectWorkspace = async (workspace: WorkspaceItem) => {
    try {
      await router.push({
        path: "/workflow",
        query: { workspaceId: workspace.id },
      });
    } catch {
      errorMessage.value = "无法打开工作空间，请稍后重试";
    }
  };

  onMounted(() => {
    fetchWorkspaces();
  });

  return {
    workspaces,
    loading,
    errorMessage,
    fetchWorkspaces,
    createWorkspace,
    selectWorkspace,
  };
}

const mapWorkspace = (workspace: WorkspaceApiItem): WorkspaceItem => ({
  id: workspace.id,
  name: workspace.name,
  workflowCount: workspace._count?.workflows ?? 0,
  knowledgeCount: 0,
  reportCount: 0,
  memberCount: workspace._count?.members ?? 0,
});
