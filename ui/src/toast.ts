/**
 * A one-line success confirmation that goes away on its own. Success-only:
 * a failed write already surfaces inline. Not interactive, so only the
 * timer removes it; a `role="status"` live region so a screen reader hears
 * it. Each view owns one, so a second write replaces the first rather than
 * queueing.
 */
import { defineComponent, onBeforeUnmount, ref, type PropType, type Ref } from "vue";

export interface ToastState {
  readonly text: string;
}

export const TOAST_DURATION_MS = 4000;

export const Toast = defineComponent({
  name: "Toast",
  props: {
    toast: { type: [Object, null] as PropType<ToastState | null>, required: true },
  },
  template: `<p v-if="toast" class="toast notice" role="status">{{ toast.text }}</p>`,
});

export interface ToastHandle {
  readonly toast: Ref<ToastState | null>;
  showToast(text: string): void;
}

/** The timer is torn down with the component. */
export function useToast(): ToastHandle {
  const toast = ref<ToastState | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function dismiss(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    toast.value = null;
  }

  function showToast(text: string): void {
    if (timer !== null) clearTimeout(timer);
    toast.value = { text };
    timer = setTimeout(dismiss, TOAST_DURATION_MS);
  }

  onBeforeUnmount(() => {
    if (timer !== null) clearTimeout(timer);
  });

  return { toast, showToast };
}
