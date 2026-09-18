import { createRouter, createWebHistory } from "vue-router";
import { useUserStore } from "@/stores/user";

const router = createRouter({
  history: createWebHistory(),

  routes: [
    {
      path: "/",
      component: () => import("@/layout/MainLayout.vue"),
      redirect: "/dashboard",
      children: [
        {
          path: "dashboard",
          name: "Dashboard",
          component: () => import("@/views/dashboard/index.vue"),
          meta: { title: "AI 聊天" },
        },
        {
          path: "knowledge",
          name: "Knowledge",
          component: () => import("@/views/knowledge/index.vue"),
          meta: { title: "知识库" },
        },
        {
          path: "workflow",
          name: "WorkflowList",
          component: () => import("@/views/workflow/list.vue"),
          meta: { title: "工作空间" },
        },
        {
          path: "report",
          name: "Report",
          component: () => import("@/views/report/index.vue"),
          meta: { title: "报告" },
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

    // 工作流编辑器：独立路由，不经过 MainLayout，只保留头部返回导航
    {
      path: "/workflow/:id",
      name: "WorkflowEditor",
      component: () => import("@/views/workflow/index.vue"),
      meta: { title: "工作流编辑", standalone: true },
    },
  ],
});

// 全局路由守卫：未登录时重定向到登录页
router.beforeEach((to) => {
  const userStore = useUserStore();
  const isAuthenticated = !!userStore.token;
  const isPublic = to.meta.public === true;

  // 公开页面（登录页）：已登录则直接跳到首页
  if (isPublic) {
    if (isAuthenticated) {
      return { path: "/dashboard" };
    }
    return true;
  }

  // 非公开页面：未登录则跳登录
  if (!isAuthenticated) {
    return { path: "/login", query: { redirect: to.fullPath } };
  }

  return true;
});

export default router;
