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
      MessagePlugin.error("登录过期，请重新登录");
      const userStore = useUserStore();
      userStore.logout();
      router.replace({ path: "/login" });
    }
    return Promise.reject(error);
  },
);
