<template>
  <div class="login-page">
    <div class="login-card">
      <!-- 品牌区 -->
      <div class="brand">
        <div class="brand-logo">AWS</div>
        <div class="brand-title">AI WorkFlow Studio</div>
        <div class="brand-subtitle">让每个想法，流动起来</div>
      </div>

      <!-- 登录 / 注册 切换 -->
      <t-tabs v-model="isRegister" class="mode-tabs">
        <t-tab-panel :value="false" label="登录" />
        <t-tab-panel :value="true" label="注册" />
      </t-tabs>

      <!-- 表单 -->
      <t-form ref="formRef" class="login-form" :data="form" :rules="formRules" :disabled="loading" @submit="submitForm">
        <t-form-item v-if="isRegister" label="用户名" name="username">
          <t-input v-model="form.username" placeholder="请输入用户名" :autosize="false" />
        </t-form-item>

        <t-form-item label="邮箱" name="email">
          <t-input v-model="form.email" type="email" placeholder="name@example.com" />
        </t-form-item>

        <t-form-item label="密码" name="password">
          <t-input v-model="form.password" type="password" placeholder="请输入密码" show-password-on="click" />
        </t-form-item>

        <t-alert v-if="errorMessage" theme="error" :message="errorMessage" class="form-alert" />

        <t-button theme="primary" type="submit" block :loading="loading" size="large" class="submit-btn">
          {{ isRegister ? "创建账号" : "进入工作台" }}
        </t-button>
      </t-form>
    </div>
  </div>
</template>

<script setup lang="ts">
import axios from "axios";
import { reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { FormInstanceFunctions, FormRule } from "tdesign-vue-next";
import { login, register } from "@/api/auth";
import { useUserStore } from "@/stores/user";

const router = useRouter();
const route = useRoute();
const userStore = useUserStore();

const isRegister = ref(false);
const loading = ref(false);
const errorMessage = ref("");
const formRef = ref<FormInstanceFunctions>();

const form = reactive({
  username: "",
  email: "",
  password: "",
});

// 表单校验规则
const formRules: Record<string, FormRule[]> = {
  username: [
    { required: true, message: "请输入用户名", trigger: "blur" },
    { min: 2, max: 32, message: "用户名长度 2-32 个字符", trigger: "blur" },
  ],
  email: [
    { required: true, message: "请输入邮箱", trigger: "blur" },
    { pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: "邮箱格式不正确", trigger: "blur" },
  ],
  password: [
    { required: true, message: "请输入密码", trigger: "blur" },
    { min: 6, message: "密码至少 6 位", trigger: "blur" },
  ],
};

// 切换登录/注册时清空错误信息
watch(isRegister, () => {
  errorMessage.value = "";
  formRef.value?.reset?.();
});

const submitForm = async () => {
  errorMessage.value = "";

  const result = await formRef.value?.validate?.();
  if (result !== true) return;

  loading.value = true;
  try {
    const response = isRegister.value
      ? await register({
        username: form.username,
        email: form.email,
        password: form.password,
      })
      : await login({ email: form.email, password: form.password });

    userStore.setToken(response.accessToken);
    userStore.setUserInfo(response.user);
    const redirect = (route.query.redirect as string) || "/chat";
    await router.push(redirect);
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const message = error.response?.data?.message;
      errorMessage.value = Array.isArray(message)
        ? message.join("；")
        : message || "请求失败，请稍后重试";
    } else {
      errorMessage.value = "请求失败，请检查网络连接";
    }
  } finally {
    loading.value = false;
  }
};
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-10) var(--space-6);
  background: linear-gradient(135deg, #f5f7fa 0%, #e4e9f2 100%);
}

.login-card {
  width: 100%;
  max-width: 420px;
  background: var(--color-bg-card);
  border-radius: var(--radius-card);
  padding: var(--space-12) var(--space-10);
  box-shadow: var(--shadow-card);
}

.brand {
  text-align: center;
  margin-bottom: var(--space-8);
}

.brand .brand-logo {
  width: 50px;
  height: 48px;
  line-height: 48px;
  margin: 0 auto var(--space-4);
  background: var(--primary);
  color: #fff;
  font-size: var(--font-xl);
  font-weight: 700;
  border-radius: var(--radius-xl);
  text-align: center;
}

.brand .brand-title {
  font-size: var(--font-xl);
  font-weight: 600;
  color: var(--color-text);
  margin-bottom: 4px;
}

.brand .brand-subtitle {
  font-size: var(--font-sm);
  color: var(--color-text-tertiary);
}

.mode-tabs {
  margin-bottom: var(--space-6);
}

.login-form .form-alert {
  margin-bottom: var(--space-4);
}

.login-form .submit-btn {
  margin-top: var(--space-2);
}

@media (max-width: 480px) {
  .login-card {
    padding: 36px var(--space-6);
    border-radius: var(--radius-xl);
  }
}
</style>
