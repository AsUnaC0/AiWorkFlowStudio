import { onMounted, ref } from "vue";
import {
  createWorkspace as createWorkspaceRequest,
  getWorkspaces,
} from "@/api/workspace";
import { createWorkflow, getWorkflows } from "@/api/workflow";
import type { WorkflowDefinition } from "@/types/workflow";
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
      const workflows = await getWorkflows(workspace.id);
      let workflowId = workflows[0]?.id;

      if (!workflowId) {
        const createdWorkflow = await createWorkflow(workspace.id, {
          name: "默认工作流",
          definition: defaultWorkflowDefinition,
        });
        workflowId = createdWorkflow.id;
      }

      await router.push({ path: `/workflow/${workflowId}` });
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

const defaultWorkflowDefinition: WorkflowDefinition = {
  nodes: [
    {
      id: "start-1",
      type: "custom",
      position: { x: 250, y: 50 },
      data: { label: "Start", nodeType: "start" },
    },
    {
      id: "output-1",
      type: "custom",
      position: { x: 250, y: 220 },
      data: { label: "Output", nodeType: "output" },
    },
  ],
  edges: [{ id: "e-start-output", source: "start-1", target: "output-1" }],
};
