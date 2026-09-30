import { onBeforeUnmount, onMounted, type Ref } from "vue";

/**
 * 点击指定元素外部时触发回调
 * @param refs 需要监听的元素 ref 数组
 * @param callback 点击外部时的回调
 */
export function useClickOutside(
  refs: Ref<HTMLElement | null> | Ref<HTMLElement | null>[],
  callback: () => void,
) {
  const refsArray = Array.isArray(refs) ? refs : [refs];

  const handleClick = (event: MouseEvent) => {
    const target = event.target as Node;
    const isInside = refsArray.some((ref) => {
      const el = ref.value;
      return el && el.contains(target);
    });
    if (!isInside) {
      callback();
    }
  };

  onMounted(() => {
    // 延迟一帧注册，避免同一事件触发
    requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClick);
    });
  });

  onBeforeUnmount(() => {
    document.removeEventListener("mousedown", handleClick);
  });
}
