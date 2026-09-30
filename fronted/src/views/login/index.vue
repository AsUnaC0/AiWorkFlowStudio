<template>
  <div class="login-page">
    <!-- 左侧装饰区（桌面端） -->
    <div class="login-decoration">
      <div class="decoration-content">
        <div class="deco-logo">✦</div>
        <h2 class="deco-title">AI WorkFlow Studio</h2>
        <p class="deco-tagline">
          Build, run and connect AI workflows.<br />
          Make your AI smarter with knowledge.
        </p>
        <div class="deco-features">
          <div class="feature-item">
            <t-icon name="flow" />
            <span>Visual workflow builder</span>
          </div>
          <div class="feature-item">
            <t-icon name="library" />
            <span>RAG-powered knowledge bases</span>
          </div>
          <div class="feature-item">
            <t-icon name="server" />
            <span>Multiple LLM providers</span>
          </div>
        </div>
      </div>
      <div class="deco-bg" />
    </div>

    <!-- 右侧表单区 -->
    <div class="login-form-area">
      <div class="login-card">
        <!-- 品牌区（移动端） -->
        <div class="brand-mobile">
          <div class="brand-logo">✦</div>
          <div class="brand-title">AI WorkFlow Studio</div>
        </div>

        <!-- 标题 -->
        <h1 class="login-heading">
          {{ isRegister ? "Create your account" : "Welcome back" }}
        </h1>
        <p class="login-sub">
          {{ isRegister ? "Start building AI workflows in minutes" : "Sign in to continue your journey" }}
        </p>

        <!-- 登录 / 注册 切换 -->
        <t-tabs v-model="isRegister" class="mode-tabs" :placement="'top'">
          <t-tab-panel :value="false" label="Sign In" />
          <t-tab-panel :value="true" label="Sign Up" />
        </t-tabs>

        <!-- 表单 -->
        <t-form ref="formRef" class="login-form" :data="form" :rules="formRules" :disabled="loading" @submit="submitForm">
          <t-form-item v-if="isRegister" label="Username" name="username">
            <t-input v-model="form.username" placeholder="Your display name" :autosize="false" />
          </t-form-item>

          <t-form-item label="Email" name="email">
            <t-input v-model="form.email" type="email" placeholder="name@example.com" />
          </t-form-item>

          <t-form-item label="Password" name="password">
            <t-input v-model="form.password" type="password" placeholder="••••••••" show-password-on="click" />
          </t-form-item>

          <t-alert v-if="errorMessage" theme="error" :message="errorMessage" class="form-alert" />

          <button type="submit" class="submit-btn" :class="{ loading }" :disabled="loading">
            <span v-if="loading" class="btn-spinner" />
            <span>{{ isRegister ? "Create Account" : "Sign In" }}</span>
          </button>
        </t-form>

        <!-- Footer -->
        <div class="login-footer">
          <template v-if="!isRegister">
            Don't have an account?
            <button class="link-btn" @click="isRegister = true">Sign up</button>
          </template>
          <template v-else>
            Already have an account?
            <button class="link-btn" @click="isRegister = false">Sign in</button>
          </template>
        </div>
      </div>
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
      ? await register({ username: form.username, email: form.email, password: form.password })
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

<style scoped lang="less">
@import "../../styles/variables.less";

.login-page {
  min-height: 100vh;
  display: flex;
  background: @color-bg;
}

/* ========== 左侧装饰 ========== */
.login-decoration {
  flex: 1;
  position: relative;
  background: linear-gradient(135deg, @primary 0%, darken(@primary, 12%) 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;

  @media (max-width: 768px) {
    display: none;
  }

  .decoration-content {
    position: relative;
    z-index: 2;
    padding: @space-12;
    max-width: 480px;
    color: #fff;
    animation: fade-slide-up @duration-slow @ease-out;
  }

  .deco-logo {
    width: 64px;
    height: 64px;
    border-radius: @radius-xl;
    background: rgba(255, 255, 255, 0.15);
    backdrop-filter: blur(10px);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 32px;
    font-weight: 700;
    margin-bottom: @space-6;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
  }

  .deco-title {
    font-size: @font-xxl;
    font-weight: 700;
    margin: 0 0 @space-4;
    letter-spacing: -0.01em;
  }

  .deco-tagline {
    font-size: @font-lg;
    line-height: 1.6;
    opacity: 0.9;
    margin: 0 0 @space-10;
  }

  .deco-features {
    display: flex;
    flex-direction: column;
    gap: @space-4;

    .feature-item {
      display: flex;
      align-items: center;
      gap: @space-3;
      font-size: @font-sm;
      opacity: 0.9;

      .t-icon {
        font-size: 18px;
      }
    }
  }

  /* 背景装饰 */
  .deco-bg {
    position: absolute;
    inset: 0;
    z-index: 1;

    &::before {
      content: "";
      position: absolute;
      width: 600px;
      height: 600px;
      top: -200px;
      right: -200px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.05);
    }

    &::after {
      content: "";
      position: absolute;
      width: 400px;
      height: 400px;
      bottom: -100px;
      left: -100px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.03);
    }
  }
}

/* ========== 右侧表单区 ========== */
.login-form-area {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: @space-12 @space-8;
  background: @color-bg-surface;
  animation: fade-slide-up @duration-slow @ease-out;
}

.login-card {
  width: 100%;
  max-width: 400px;

  .brand-mobile {
    display: none;
    text-align: center;
    margin-bottom: @space-8;

    @media (max-width: 768px) {
      display: block;
    }

    .brand-logo {
      width: 48px;
      height: 48px;
      border-radius: @radius-xl;
      background: linear-gradient(135deg, @primary 0%, lighten(@primary, 8%) 100%);
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      font-weight: 700;
      margin: 0 auto @space-3;
      box-shadow: 0 4px 16px @primary-shadow;
    }

    .brand-title {
      font-size: @font-lg;
      font-weight: 600;
      color: @color-text;
    }
  }

  .login-heading {
    font-size: 26px;
    font-weight: 700;
    color: @color-text;
    margin: 0 0 @space-2;
    letter-spacing: -0.01em;
  }

  .login-sub {
    font-size: @font-sm;
    color: @color-text-secondary;
    margin: 0 0 @space-6;
  }

  .mode-tabs {
    margin-bottom: @space-6;
    border-bottom: 1px solid @color-border;

    :deep(.t-tabs__nav-item) {
      font-weight: 500;
    }
  }

  .submit-btn {
    width: 100%;
    height: 44px;
    margin-top: @space-4;
    background: @primary;
    color: #fff;
    border: none;
    border-radius: @radius-lg;
    font-size: @font-base;
    font-weight: 600;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: @space-2;
    transition: all @duration-fast;
    box-shadow: 0 2px 8px @primary-shadow;

    &:hover:not(:disabled) {
      background: @primary-hover;
      box-shadow: 0 4px 16px @primary-shadow;
    }

    &:active:not(:disabled) {
      transform: translateY(1px);
    }

    &:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    &.loading {
      gap: @space-2;
    }

    .btn-spinner {
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-top-color: #fff;
      border-radius: 50%;
      animation: running-ring 0.8s linear infinite;
    }
  }

  .login-footer {
    margin-top: @space-6;
    text-align: center;
    font-size: @font-sm;
    color: @color-text-tertiary;

    .link-btn {
      background: none;
      border: none;
      color: @primary;
      font-size: inherit;
      font-weight: 500;
      cursor: pointer;
      padding: 0;
      margin-left: 4px;

      &:hover {
        color: @primary-hover;
        text-decoration: underline;
      }
    }
  }
}

/* 表单通用 */
.login-form {
  :deep(.t-input__inner),
  :deep(.t-textarea__inner) {
    height: 44px;
    border-radius: @radius-md;
  }
}

/* 响应式 */
@media (max-width: 768px) {
  .login-form-area {
    padding: @space-8 @space-6;
  }
}
</style>
