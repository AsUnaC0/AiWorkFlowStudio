import { createRouter, createWebHistory } from "vue-router";

const router = createRouter({
  history: createWebHistory(),

  routes: [
    {
      path: "/",
      redirect: "/login",
    },

    {
      path: "/login",
      name: "Login",
      component: () => import("@/views/login/index.vue"),
    },

    {
      path: "/dashboard",
      component: () => import("@/views/dashboard/index.vue"),
    },

    {
      path: "/workflow",
      component: () => import("@/views/workflow/index.vue"),
    },

    {
      path: "/workflow/:id",
      component: () => import("@/views/workflow/index.vue"),
    },

    {
      path: "/knowledge",
      component: () => import("@/views/knowledge/index.vue"),
    },

    {
      path: "/report",
      component: () => import("@/views/report/index.vue"),
    },
  ],
});

export default router;
