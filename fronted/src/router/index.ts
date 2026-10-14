import { createRouter, createWebHistory } from "vue-router";
import { useUserStore } from "@/stores/user";
import { isTokenExpired } from "@/utils/token";

const router = createRouter({
  history: createWebHistory(),

  routes: [
    {
      path: "/",
      component: () => import("@/layout/MainLayout.vue"),
      redirect: "/chat",
      children: [
        {
          path: "dashboard",
          name: "Dashboard",
          component: () => import("@/views/dashboard/index.vue"),
          meta: { title: "控制台" },
        },
        {
          path: "chat",
          name: "Chat",
          component: () => import("@/views/chat/index.vue"),
          // keepAlive：聊天页必须缓存。
          // 流式回答期间切到别的菜单，组件一旦销毁，SSE 回调就找不到目标消息、
          // 数据被静默丢弃，切回来只能看到空白回答。
          // 注意：MainLayout 的 <keep-alive :include> 匹配的是「组件 name」，
          // 因此该页面组件必须 defineOptions({ name: "Chat" }) 与这里保持一致。
          meta: { title: "chat", keepAlive: true },
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
        // 好友列表
        {
          path: "friends",
          name: "FriendList",
          component: () => import("@/views/friends/index.vue"),
          meta: { title: "好友" },
        },
        // Skills 管理
        {
          path: "skills",
          name: "SkillList",
          component: () => import("@/views/skills/index.vue"),
          meta: { title: "Skills" },
        },
        // MCP Server 管理
        {
          path: "mcp",
          name: "McpList",
          component: () => import("@/views/mcp/index.vue"),
          meta: { title: "MCP" },
        },
        // Agent 管理
        {
          path: "agents",
          name: "AgentList",
          component: () => import("@/views/agents/index.vue"),
          meta: { title: "Agent 管理" },
        },
        {
          path: "agents/:id",
          name: "AgentDetail",
          component: () => import("@/views/agents/detail.vue"),
          meta: { title: "Agent 配置" },
        },
        // 模型管理（LLM Providers）
        {
          path: "providers",
          name: "ProviderList",
          component: () => import("@/views/providers/index.vue"),
          meta: { title: "模型管理" },
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
  const isPublic = to.meta.public === true;

  // token 存在但已过期：先清掉，避免「先放行进页面、请求 401 后才被踢回登录页」
  const expired = !!userStore.token && isTokenExpired(userStore.token);
  if (expired) {
    userStore.logout();
  }
  const isAuthenticated = !!userStore.token && !expired;

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
