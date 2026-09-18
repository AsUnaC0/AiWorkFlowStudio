<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";

const props = withDefaults(
  defineProps<{
    title: string;
    subtitle?: string;
    showBack?: boolean;
    /** 点击返回按钮时跳转的路径，不传则使用 router.back() */
    backPath?: string;
    /** 返回按钮上的提示文字，默认 "← 返回" */
    backText?: string;
  }>(),
  {
    showBack: true,
    backText: "← 返回",
  },
);

const emit = defineEmits<{
  (e: "back"): void;
}>();

const router = useRouter();

const handleBack = () => {
  emit("back");
  if (props.backPath) {
    router.push(props.backPath);
  } else {
    router.back();
  }
};

const titleClass = computed(() => ({
  "page-title": true,
  "page-title--with-sub": !!props.subtitle,
}));
</script>

<template>
  <header class="page-header">
    <div class="page-header__left">
      <t-button v-if="showBack" variant="outline" size="small" class="page-header__back" @click="handleBack">
        {{ backText }}
      </t-button>
      <div class="page-header__title-wrap">
        <h1 :class="titleClass">{{ title }}</h1>
        <p v-if="subtitle" class="page-header__subtitle">{{ subtitle }}</p>
      </div>
    </div>
    <div class="page-header__right">
      <slot />
    </div>
  </header>
</template>

<style lang="less" scoped>
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--header-height);
  padding: 0 var(--space-6);
  background-color: var(--color-bg-white);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
  box-sizing: border-box;

  &__left {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    min-width: 0;
    flex: 1;
  }

  &__back {
    flex-shrink: 0;
  }

  &__title-wrap {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .page-title {
    font-size: var(--font-xl);
    font-weight: 600;
    color: var(--color-text);
    margin: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;

    &--with-sub {
      font-size: var(--font-lg);
    }
  }

  &__subtitle {
    font-size: var(--font-sm);
    color: var(--color-text-tertiary);
    margin: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &__right {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }
}
</style>
