import axios from "axios";
import { useUserStore } from "@/stores/user";
import router from "@/router";
import { MessagePlugin } from "tdesign-vue-next";

export const request = axios.create({
  baseURL: "/api",
  timeout: 100000,
});

/**
 * 登录失效后的「静默窗口」。
 *
 * 一个页面挂载时往往会并发/串行发出好几个请求，token 失效时它们会一起 401。
 * 若每个 401 都各弹一次提示、各跳一次登录页，用户看到的就是一串重复报错。
 * 这里约定：同一波失效只处理一次，其余请求直接取消，不再打扰用户。
 */
const AUTH_WINDOW_MS = 1500;
let authRedirecting = false;
let lastAuthNoticeAt = 0;

/** 登录/注册接口的错误由登录页在表单里内联展示，不需要额外的全局提示。 */
const isLoginRequest = (url = "") => url.includes("/auth/login");
const isRegisterRequest = (url = "") => url.includes("/auth/register");

/** 判断错误是否由「登录失效」引起（401，或被取消的后续请求）。 */
export const isAuthFailure = (error: unknown): boolean =>
  axios.isCancel(error) ||
  (axios.isAxiosError(error) && error.response?.status === 401);

const startAuthRedirect = () => {
  const now = Date.now();

  // 同一波 401 只提示一次
  if (now - lastAuthNoticeAt > AUTH_WINDOW_MS) {
    lastAuthNoticeAt = now;
    MessagePlugin.error("登录已过期，请重新登录");
  }

  // 只跳转一次；带上来源地址，登录后可以回跳
  if (authRedirecting) return;
  authRedirecting = true;

  const userStore = useUserStore();
  const redirect = router.currentRoute.value.fullPath;
  userStore.logout();

  router
    .replace({
      path: "/login",
      query: redirect.startsWith("/login") ? {} : { redirect },
    })
    .catch(() => undefined)
    .finally(() => {
      setTimeout(() => {
        authRedirecting = false;
      }, AUTH_WINDOW_MS);
    });
};

request.interceptors.request.use(
  (config) => {
    const userStore = useUserStore();
    const url = config.url ?? "";

    // 已经确认登录失效（且还没重新登录）：后续请求没必要再发出去，直接取消。
    // 登录/注册必须放行，否则用户在这 1.5s 内提交登录会被一起取消。
    if (
      authRedirecting &&
      !userStore.token &&
      !isLoginRequest(url) &&
      !isRegisterRequest(url)
    ) {
      return Promise.reject(new axios.Cancel("登录状态已失效，请求已取消"));
    }

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
    if (axios.isCancel(error)) {
      return Promise.reject(error);
    }

    const url = error.config?.url ?? "";

    if (error.response?.status === 401) {
      // 登录接口失败时登录页会内联展示「邮箱或密码不正确」，这里不重复提示、也不跳转
      if (!isLoginRequest(url)) {
        startAuthRedirect();
      }
      return Promise.reject(error);
    }

    // 其他错误：优先显示后端返回的 message（登录/注册由页面内联展示，跳过全局提示）
    const data = error.response?.data;
    const rawMessage = Array.isArray(data?.message)
      ? data.message.join("；")
      : data?.message;
    const msg = rawMessage || data?.error || error.message || "请求失败";
    if (!isLoginRequest(url) && !isRegisterRequest(url)) {
      MessagePlugin.error(msg);
    }

    return Promise.reject(error);
  },
);
