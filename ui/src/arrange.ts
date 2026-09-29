/**
 * How a list of postings is arranged, in two independent choices: the view
 * (one flat list, or grouped under company headers) and the sort (the order
 * rows take, and in the grouped view the order companies take by their first
 * row). The Queue and the Record each carry both and each remembers its own.
 */
import { defineComponent, type PropType } from "vue";

import type { SessionStore } from "./auth.ts";

export const VIEWS = ["list", "company"] as const;
export type ListView = (typeof VIEWS)[number];

export const VIEW_LABELS: Record<ListView, string> = {
  list: "List",
  company: "By company",
};

/** Every sort either tab offers; each tab names the ones it shows. */
export type Sort = "acted" | "score" | "posted";

export const SORT_LABELS: Record<Sort, string> = {
  acted: "Recently acted",
  score: "By score",
  posted: "Newest first",
};

/** Nothing in the queue has been acted on, so "Recently acted" is the Record's alone. */
export const QUEUE_SORTS = ["score", "posted"] as const satisfies readonly Sort[];
export const RECORD_SORTS = ["acted", "score", "posted"] as const satisfies readonly Sort[];

export type ArrangedTab = "queue" | "record";

export interface Arrangement {
  readonly view: ListView;
  readonly sort: Sort;
}

export function viewKey(tab: ArrangedTab): string {
  return `${tab}-view`;
}

export function sortKey(tab: ArrangedTab): string {
  return `${tab}-sort`;
}

/**
 * The single order the Queue remembered before view and sort split
 * (2026-09-29). Read once as a fallback so the choice already made survives
 * the change; never written.
 */
export const LEGACY_QUEUE_ORDER_KEY = "queue-order";

function legacyQueueArrangement(store: SessionStore): Partial<Arrangement> {
  const stored = store.getItem(LEGACY_QUEUE_ORDER_KEY);
  if (stored === "company") return { view: "company", sort: "score" };
  if (stored === "posted") return { view: "list", sort: "posted" };
  return {};
}

/** The tab's first sort and the flat list, unless the store remembers a choice this tab still offers. */
export function loadArrangement(
  store: SessionStore,
  tab: ArrangedTab,
  sorts: readonly Sort[],
): Arrangement {
  const legacy = tab === "queue" ? legacyQueueArrangement(store) : {};
  const storedView = store.getItem(viewKey(tab));
  const storedSort = store.getItem(sortKey(tab));
  const view =
    storedView !== null && (VIEWS as readonly string[]).includes(storedView)
      ? (storedView as ListView)
      : (legacy.view ?? "list");
  const sort =
    storedSort !== null && (sorts as readonly string[]).includes(storedSort)
      ? (storedSort as Sort)
      : legacy.sort !== undefined && sorts.includes(legacy.sort)
        ? legacy.sort
        : (sorts[0] ?? "score");
  return { view, sort };
}

/** A failed write (quota, private browsing) must not break the page. */
function remember(store: SessionStore, key: string, value: string): void {
  try {
    store.setItem(key, value);
  } catch {
    // Unremembered; the in-memory choice the page is already showing stands.
  }
}

export function saveView(store: SessionStore, tab: ArrangedTab, view: ListView): void {
  remember(store, viewKey(tab), view);
}

export function saveSort(store: SessionStore, tab: ArrangedTab, sort: Sort): void {
  remember(store, sortKey(tab), sort);
}

/**
 * Two button groups, each a set of mutually exclusive toggles. Each group is
 * named by its visible label ("View", "Sort") prefixed with the tab, so a
 * screen reader landing in it hears which list it arranges.
 */
export const ArrangeBar = defineComponent({
  name: "ArrangeBar",
  props: {
    tab: { type: String as PropType<ArrangedTab>, required: true },
    tabLabel: { type: String, required: true },
    view: { type: String as PropType<ListView>, required: true },
    sort: { type: String as PropType<Sort>, required: true },
    sorts: { type: Array as PropType<readonly Sort[]>, required: true },
  },
  emits: {
    view: (_view: ListView) => true,
    sort: (_sort: Sort) => true,
  },
  setup() {
    return { VIEWS, VIEW_LABELS, SORT_LABELS };
  },
  template: `
    <div class="arrange">
      <div class="order" role="group" :aria-labelledby="tab + '-view-label'">
        <span class="order-label" :id="tab + '-view-label'"><span class="sr-only">{{ tabLabel }} </span>View</span>
        <button
          v-for="v in VIEWS"
          :key="v"
          type="button"
          :class="{ primary: view === v }"
          :aria-pressed="view === v"
          @click="$emit('view', v)">{{ VIEW_LABELS[v] }}</button>
      </div>
      <div class="order" role="group" :aria-labelledby="tab + '-sort-label'">
        <span class="order-label" :id="tab + '-sort-label'"><span class="sr-only">{{ tabLabel }} </span>Sort</span>
        <button
          v-for="s in sorts"
          :key="s"
          type="button"
          :class="{ primary: sort === s }"
          :aria-pressed="sort === s"
          @click="$emit('sort', s)">{{ SORT_LABELS[s] }}</button>
      </div>
    </div>
  `,
});
