/** An open tray, not a checkmark or any glyph that could read as an outcome: an empty bucket is not a success. */
import { defineComponent } from "vue";

export const EmptyState = defineComponent({
  name: "EmptyState",
  props: { text: { type: String, required: true } },
  template: `
    <p class="empty">
      <svg class="empty-mark" viewBox="0 0 32 20" width="48" height="30" aria-hidden="true"
           fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M2 8h8l3 4h6l3-4h8" /><path d="M2 8l3 10h22l3-10" />
      </svg>
      <span>{{ text }}</span>
    </p>
  `,
});
