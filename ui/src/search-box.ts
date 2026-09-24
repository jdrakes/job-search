/**
 * One labelled search field. It holds no state: the view owns the text
 * and this takes a value and emits the next one.
 */
import { defineComponent } from "vue";

export const SearchBox = defineComponent({
  name: "SearchBox",
  props: {
    value: { type: String, required: true },
    /** A `<label>`, not a placeholder, so it survives being typed into. */
    label: { type: String, default: "Search" },
    placeholder: { type: String, default: "" },
  },
  emits: {
    search: (value: string) => typeof value === "string",
  },
  /*
   * `:value` + `@input`, never `v-model`: `v-model` drops input events
   * during a composition, and iOS marks autocorrect candidates that way, so
   * typing on an iPhone narrowed nothing. Autocorrect and autocapitalize
   * are off because a company name is not a word to fix.
   */
  template: `
    <label class="search-box">
      <span>{{ label }}</span>
      <input
        type="search"
        autocorrect="off"
        autocapitalize="off"
        :placeholder="placeholder"
        :value="value"
        @input="$emit('search', $event.target.value)" />
    </label>
  `,
});
