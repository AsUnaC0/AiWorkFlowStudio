import axios from "axios";
import { useUserStore } from "@/stores/user";
import router from "@/router";
import { MessagePlugin } from "tdesign-vue-next";

export const request = axios.create({
  baseURL: "/api",
  timeout: 100000,
});

request.interceptors.request.use(
  (config) => {
    const userStore = useUserStore();
    if (userStore.token) {
      config.headers.Authorization = `Bearer ${userStore.token}`;
    }
    return config;
  },
  (error) => Promise.reject(error),
);

request.interceptors.response.use(
  (response) => response.data,
  (error) => {
    if (error.response?.status === 401) {
      const msg = error.response?.data?.message || "登录过期，请重新登录";
      MessagePlugin.error(msg);
      const userStore = useUserStore();
      userStore.logout();
      router.replace({ path: "/login" });
    } else {
      // 其他错误：优先显示后端返回的 message
      const msg =
        error.response?.data?.message ||
        error.response?.data?.error ||
        error.message ||
        "请求失败";
      MessagePlugin.error(msg);
    }
    return Promise.reject(error);
  },
);
