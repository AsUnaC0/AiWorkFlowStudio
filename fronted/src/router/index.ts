import { createRouter, createWebHistory } from "vue-router";
import { useUserStore } from "@/stores/user";

const router = createRouter({
  history: createWebHistory(),

  routes: [
    {
      path: "/",
      component: () => import("@/layout/MainLayout.vue"),
      redirect: "/chat",
      children: [
        {
          path: "chat",
          name: "Chat",
          component: () => import("@/views/chat/index.vue"),
          meta: { title: "chat" },
        },
        // 知识库列表（先选 workspace）
        {
          path: "knowledge",
          name: "KnowledgeList",
          component: () => import("@/views/knowledge/index.vue"),
          meta: { title: "知识库" },
        },
        // 知识库详情（文件管理）
        {
          path: "knowledge/:kbId",
          name: "KnowledgeDetail",
          component: () => import("@/views/knowledge/detail.vue"),
          meta: { title: "知识库详情" },
        },
        // 工作空间（工作流列表）
        {
          path: "workspace",
          name: "WorkspaceList",
          component: () => import("@/views/workspace/index.vue"),
          meta: { title: "工作空间" },
        },
      ],
    },

    // 登录页：独立路由，不经过 MainLayout
    {
      path: "/login",
      name: "Login",
      component: () => import("@/views/login/index.vue"),
      meta: { title: "登录", public: true },
    },

    // 工作流编辑器：独立路由，不经过 MainLayout
    {
      path: "/workspace/:id",
      name: "WorkflowEditor",
      component: () => import("@/views/workspace/workflow.vue"),
      meta: { title: "工作流编辑", standalone: true },
    },
  ],
});

// 全局路由守卫
router.beforeEach((to) => {
  const userStore = useUserStore();
  const isAuthenticated = !!userStore.token;
  const isPublic = to.meta.public === true;

  if (isPublic) {
    if (isAuthenticated) return { path: "/chat" };
    return true;
  }

  if (!isAuthenticated) {
    return { path: "/login", query: { redirect: to.fullPath } };
  }

  return true;
});

export default router;
