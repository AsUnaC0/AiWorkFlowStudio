<template>
  <main class="login-page">
    <section class="intro-panel">
      <div class="brand-mark">AI</div>
      <p class="eyebrow">AI WORKFLOW STUDIO</p>
      <h1>让每个想法，<br /><em>流动起来。</em></h1>
      <p class="intro-copy">连接知识、模型与团队，构建属于你的智能工作流。</p>
    </section>

    <section class="form-panel">
      <div class="form-shell">
        <div class="form-heading">
          <p class="eyebrow">WELCOME BACK</p>
          <h2>{{ isRegister ? "创建账号" : "登录工作台" }}</h2>
          <p>
            {{
              isRegister
                ? "注册后即可开始构建你的第一个工作流"
                : "输入账号信息，继续你的工作"
            }}
          </p>
        </div>

        <div class="mode-switch" role="tablist" aria-label="登录或注册">
          <button
            :class="{ active: !isRegister }"
            type="button"
            @click="switchMode(false)"
          >
            登录
          </button>
          <button
            :class="{ active: isRegister }"
            type="button"
            @click="switchMode(true)"
          >
            注册
          </button>
        </div>

        <form @submit.prevent="submitForm">
          <label v-if="isRegister" class="field">
            <span>用户名</span>
            <input
              v-model.trim="form.username"
              autocomplete="username"
              placeholder="请输入用户名"
            />
          </label>

          <label class="field">
            <span>邮箱</span>
            <input
              v-model.trim="form.email"
              autocomplete="email"
              type="email"
              placeholder="name@example.com"
            />
          </label>

          <label class="field">
            <span>密码</span>
            <input
              v-model="form.password"
              autocomplete="current-password"
              type="password"
              placeholder="请输入密码"
            />
          </label>

          <p v-if="errorMessage" class="error-message">{{ errorMessage }}</p>
          <button class="submit-button" :disabled="loading" type="submit">
            {{ loading ? "提交中..." : isRegister ? "创建账号" : "进入工作台" }}
            <span aria-hidden="true">→</span>
          </button>
        </form>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import axios from "axios";
import { reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { login, register } from "@/api/auth";
import { useUserStore } from "@/stores/user";

const router = useRouter();
const userStore = useUserStore();
const isRegister = ref(false);
const loading = ref(false);
const errorMessage = ref("");
const form = reactive({
  username: "",
  email: "",
  password: "",
});

const switchMode = (registerMode: boolean) => {
  isRegister.value = registerMode;
  errorMessage.value = "";
};

const submitForm = async () => {
  errorMessage.value = "";
  if (!form.email || !form.password || (isRegister.value && !form.username)) {
    errorMessage.value = "请完整填写表单信息";
    return;
  }

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
    await router.push("/dashboard");
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
.login-page {
  min-height: 100%;
  display: grid;
  grid-template-columns: minmax(360px, 0.9fr) minmax(420px, 1.1fr);
  background: #f6f4ef;
  color: #202b2b;
}

.intro-panel {
  padding: clamp(48px, 8vw, 120px);
  display: flex;
  flex-direction: column;
  justify-content: center;
  background: #173d3b;
  color: #f7f2e9;
}

.brand-mark {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  margin-bottom: 72px;
  border: 1px solid #d9c6a1;
  color: #d9c6a1;
  font:
    700 14px Georgia,
    serif;
  letter-spacing: 0;
}

.eyebrow {
  margin: 0 0 18px;
  color: #b79b6d;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 2px;
}

h1,
h2 {
  margin: 0;
  font-family: Georgia, "Times New Roman", serif;
  font-weight: 400;
  letter-spacing: 0;
}

h1 {
  font-size: clamp(42px, 5vw, 72px);
  line-height: 1.08;
}

h1 em {
  color: #d9c6a1;
  font-style: italic;
}

.intro-copy {
  max-width: 280px;
  margin: 28px 0 0;
  color: #b9c7c1;
  font-size: 15px;
  line-height: 1.8;
}

.form-panel {
  display: grid;
  place-items: center;
  padding: 40px 24px;
}

.form-shell {
  width: min(100%, 420px);
}

.form-heading h2 {
  font-size: 38px;
}

.form-heading > p:last-child {
  margin: 12px 0 36px;
  color: #77817e;
  font-size: 14px;
}

.mode-switch {
  display: flex;
  gap: 28px;
  margin-bottom: 28px;
  border-bottom: 1px solid #d9ddd8;
}

.mode-switch button {
  padding: 0 0 12px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: #8a9490;
  cursor: pointer;
  font-size: 14px;
}

.mode-switch button.active {
  border-bottom-color: #173d3b;
  color: #173d3b;
  font-weight: 700;
}

.field {
  display: block;
  margin-bottom: 18px;
}

.field span {
  display: block;
  margin-bottom: 8px;
  color: #53605c;
  font-size: 13px;
  font-weight: 700;
}

.field input {
  width: 100%;
  height: 48px;
  padding: 0 14px;
  border: 1px solid #d9ddd8;
  border-radius: 2px;
  outline: 0;
  background: #fffdf9;
  color: #202b2b;
  font: inherit;
  transition:
    border-color 160ms ease,
    box-shadow 160ms ease;
}

.field input:focus {
  border-color: #477a72;
  box-shadow: 0 0 0 3px rgba(71, 122, 114, 0.12);
}

.error-message {
  margin: 4px 0 16px;
  color: #b04c42;
  font-size: 13px;
  line-height: 1.5;
}

.submit-button {
  width: 100%;
  height: 50px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 18px;
  border: 0;
  border-radius: 2px;
  background: #173d3b;
  color: #fffdf9;
  cursor: pointer;
  font: inherit;
  font-weight: 700;
  transition:
    background 160ms ease,
    transform 160ms ease;
}

.submit-button:hover:not(:disabled) {
  background: #245754;
  transform: translateY(-1px);
}

.submit-button:disabled {
  cursor: wait;
  opacity: 0.65;
}

@media (max-width: 720px) {
  .login-page {
    display: block;
  }

  .intro-panel {
    min-height: 300px;
    padding: 36px 28px;
  }

  .brand-mark {
    margin-bottom: 38px;
  }

  h1 {
    font-size: 42px;
  }

  .form-panel {
    padding: 48px 28px 64px;
  }
}
</style>
