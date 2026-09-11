import { defineStore } from "pinia";
import { ref } from "vue";
import type { User } from "@/types/auth";

export const useUserStore = defineStore("user", () => {
  const token = ref<string>(localStorage.getItem("token") || "");
  const userInfo = ref<User | null>(null);

  const setToken = (newToken: string) => {
    token.value = newToken;
    localStorage.setItem("token", newToken);
  };

  const setUserInfo = (user: User) => {
    userInfo.value = user;
  };

  const logout = () => {
    token.value = "";
    userInfo.value = null;
    localStorage.removeItem("token");
  };

  return { token, userInfo, setToken, setUserInfo, logout };
});
