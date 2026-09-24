/** A list, not four hand-written buttons, so a tab cannot be added to the panel switch and forgotten here. */
import { defineComponent, type PropType } from "vue";

export const TABS = [
  { id: "queue", label: "Queue" },
  { id: "record", label: "Record" },
  { id: "companies", label: "Companies" },
  { id: "criteria", label: "Criteria" },
] as const;

export type TabId = (typeof TABS)[number]["id"];

export const TabBar = defineComponent({
  name: "TabBar",
  props: {
    current: { type: String as PropType<TabId>, required: true },
    counts: { type: Object as PropType<Partial<Record<TabId, number>>>, default: () => ({}) },
    // A round is in flight. Every count a tab shows is the last round's
    // until this one answers, so the ring stands in its place.
    busy: { type: Boolean, default: false },
  },
  emits: ["select"],
  setup() {
    return { tabs: TABS };
  },
  template: `
    <div role="tablist" aria-label="Views">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        role="tab"
        :id="'tab-' + tab.id"
        :aria-selected="tab.id === current"
        :aria-controls="'panel-' + tab.id"
        :class="{ current: tab.id === current }"
        @click="$emit('select', tab.id)">{{ tab.label }}<span
          class="count"
          :class="{ recounting: busy }"
          v-if="counts[tab.id] !== undefined"><span class="count-value">{{ counts[tab.id] }}</span><span class="spinner" v-if="busy" aria-hidden="true"></span></span></button>
    </div>
  `,
});
