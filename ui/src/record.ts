/**
 * The record: every posting the processor kept, in any status. Filtering
 * runs over what the shell handed down, which is the last round with
 * whatever James has decided since laid over it, so a row states its new
 * status the moment its write lands.
 */
import { computed, defineComponent, ref, type PropType } from "vue";

import { STATUSES, type PostingSummary, type Status } from "../../src/schema.ts";
import {
  ArrangeBar,
  loadArrangement,
  RECORD_SORTS,
  saveSort,
  saveView,
  type ListView,
  type Sort,
} from "./arrange.ts";
import type { SessionStore } from "./auth.ts";
import type { AppConfig } from "./config.ts";
import { EmptyState } from "./empty-state.ts";
import { useMasterDetail } from "./master-detail.ts";
import { labelOf, outcomeToastText, PostingCard, type DecidedOutcome } from "./posting.ts";
import {
  companyHeadLabel,
  groupedByCompany,
  NULL_STORE,
  queueRows,
  sortedPostings,
} from "./queue.ts";
import { contains } from "./text-match.ts";
import { Toast, useToast } from "./toast.ts";

/** A status to filter on, "" for all, or "queue" for the rows with none. */
export type StatusFilter = Status | "" | "queue";

export interface RecordFilters {
  readonly status: StatusFilter;
  readonly company: string;
  readonly title: string;
}

function matchesStatus(posting: PostingSummary, filter: StatusFilter): boolean {
  if (filter === "") return true;
  if (filter === "queue") return posting.status === null;
  return posting.status === filter;
}

/** Shown in the select's options, so a filter that matches nothing is never a surprise. */
export function statusCounts(
  postings: readonly PostingSummary[],
): ReadonlyMap<StatusFilter, number> {
  const counts = new Map<StatusFilter, number>();
  for (const posting of postings) {
    const key: StatusFilter = posting.status ?? "queue";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Which filter emptied the result, when one alone did. */
export function emptyLabel(filters: RecordFilters): string {
  const textSet = filters.company.trim() !== "" || filters.title.trim() !== "";
  if (filters.status === "" || textSet) return "Nothing matches.";
  if (filters.status === "queue") return "Nothing is in the queue.";
  return `No postings marked ${labelOf(filters.status)} yet.`;
}

export function filteredRecord(
  postings: readonly PostingSummary[],
  filters: RecordFilters,
): PostingSummary[] {
  return postings.filter(
    (posting) =>
      matchesStatus(posting, filters.status) &&
      contains(posting.company, filters.company) &&
      contains(posting.title, filters.title),
  );
}

/**
 * By default acted-on postings first, most recent `status_at` first, the
 * rest in score order. In the company view every row sits under its company,
 * companies in the order their first row earned under the same sort.
 */
export function orderedRecord(
  postings: readonly PostingSummary[],
  compFloor: number | null,
  nowMs: number,
  productWords: readonly string[] = [],
  sort: Sort = "acted",
  view: ListView = "list",
): PostingSummary[] {
  const sorted = sortedPostings(postings, sort, compFloor, nowMs, productWords);
  return view === "company" ? groupedByCompany(sorted) : sorted;
}

/*
 * The two text filters bind `:value` + `@input`, not `v-model`: `v-model`
 * drops input events during a composition, and iOS marks autocorrect
 * candidates that way, so typing on an iPhone would narrow nothing.
 * Autocorrect is off on both: a company name is not a word to fix.
 */
export const RecordView = defineComponent({
  name: "RecordView",
  components: { ArrangeBar, PostingCard, EmptyState, Toast },
  props: {
    postings: { type: Array as PropType<PostingSummary[]>, required: true },
    config: { type: Object as PropType<AppConfig>, required: true },
    accessToken: { type: String, required: true },
    // Null when the criteria read failed; no card then guesses one.
    compFloor: { type: [Number, null] as PropType<number | null>, required: true },
    productWords: { type: Array as PropType<readonly string[]>, default: () => [] },
    // Where the chosen view and sort are remembered across a reload.
    store: { type: Object as PropType<SessionStore>, default: () => NULL_STORE },
  },
  emits: {
    // Handed up to `AppRoot`, which lays the patch over both reads; this
    // view keeps no copy of its own.
    decided: (_outcome: DecidedOutcome) => true,
  },
  setup(props, { emit }) {
    const status = ref<StatusFilter>("");
    const company = ref("");
    const title = ref("");
    const initial = loadArrangement(props.store, "record", RECORD_SORTS);
    const view = ref<ListView>(initial.view);
    const sort = ref<Sort>(initial.sort);
    function setView(next: ListView): void {
      view.value = next;
      saveView(props.store, "record", next);
    }
    function setSort(next: Sort): void {
      sort.value = next;
      saveSort(props.store, "record", next);
    }
    const { toast, showToast } = useToast();
    const filters = computed<RecordFilters>(() => ({
      status: status.value,
      company: company.value,
      title: title.value,
    }));
    const filtered = computed(() =>
      orderedRecord(
        filteredRecord(props.postings, filters.value),
        props.compFloor,
        Date.now(),
        props.productWords,
        sort.value,
        view.value,
      ),
    );
    const rows = computed(() => queueRows(filtered.value, view.value === "company", false));
    // The reveal belongs to the view: this list drops and remounts a row
    // whenever a filter stops matching it. The Record never removes a row
    // live on decide, so `resolveSelection`'s own fallback handles a
    // selected posting filtered out from under it.
    const {
      selectedKey,
      selected,
      paneMode,
      onListKeydown,
      advanceSelection,
      onRevealed,
      isRevealed,
    } = useMasterDetail(filtered);
    function onDecided(decided: DecidedOutcome): void {
      // Read before the patch comes back down and changes the order, so the
      // pane advances to the successor James is looking at rather than to
      // whatever `filtered` becomes once the written row sorts to the top of
      // the acted-on block.
      advanceSelection(decided.key);
      emit("decided", decided);
      showToast(outcomeToastText(decided.patch.status, decided.company));
    }
    const counts = computed(() => statusCounts(props.postings));
    const countOf = (filter: StatusFilter): number => counts.value.get(filter) ?? 0;
    const empty = computed(() => emptyLabel(filters.value));
    const activeFilters = computed(
      () => [status.value, company.value.trim(), title.value.trim()].filter((v) => v !== "").length,
    );
    // Empty until a filter is set, and the `<p>` showing it is always in the
    // tree: see the note on `matchedText` in `ui/src/queue.ts`.
    const matchedText = computed(() =>
      activeFilters.value > 0 ? `${filtered.value.length} of ${props.postings.length}` : "",
    );
    return {
      activeFilters,
      matchedText,
      status,
      company,
      title,
      filtered,
      rows,
      companyHeadLabel,
      view,
      sort,
      setView,
      setSort,
      RECORD_SORTS,
      paneMode,
      selectedKey,
      selected,
      countOf,
      empty,
      STATUSES,
      labelOf,
      isRevealed,
      onDecided,
      onRevealed,
      onListKeydown,
      toast,
    };
  },
  template: `
    <section role="tabpanel" id="panel-record" aria-labelledby="tab-record" tabindex="-1">
      <ArrangeBar tab="record" tab-label="Record" :view="view" :sort="sort" :sorts="RECORD_SORTS" @view="setView" @sort="setSort" />
      <details class="filters">
        <summary>Filters<span class="count" v-if="activeFilters > 0">{{ activeFilters }}</span></summary>
        <div class="fields">
        <label>
          <span>Status</span>
          <select :value="status" @change="status = $event.target.value">
            <option value="">All ({{ postings.length }})</option>
            <option value="queue">In queue ({{ countOf('queue') }})</option>
            <option v-for="s in STATUSES" :key="s" :value="s">{{ labelOf(s) }} ({{ countOf(s) }})</option>
          </select>
        </label>
        <label>
          <span>Company</span>
          <input
            type="search"
            autocorrect="off"
            autocapitalize="off"
            :value="company"
            @input="company = $event.target.value" />
        </label>
        <label>
          <span>Title</span>
          <input
            type="search"
            autocorrect="off"
            autocapitalize="off"
            :value="title"
            @input="title = $event.target.value" />
        </label>
        </div>
      </details>
      <p class="matched" role="status">{{ matchedText }}</p>
      <EmptyState v-if="filtered.length === 0" :text="empty" />
      <div class="master-detail" v-else>
        <div class="list" :class="{ grouped: view === 'company' }" @keydown="onListKeydown">
          <template v-for="row in rows" :key="row.posting.key">
            <h2 v-if="row.head !== null" class="company-head"><span class="company">{{ row.head.company }}</span> &mdash; {{ companyHeadLabel(row.head) }}</h2>
            <PostingCard
              :posting="row.posting"
              :config="config"
              :access-token="accessToken"
              :comp-floor="compFloor"
              :product-words="productWords"
              :selected="paneMode && selected !== null && row.posting.key === selected.key"
              :expandable="!paneMode"
              :revealed="isRevealed(row.posting.key)"
              @activated="selectedKey = $event"
              @revealed="onRevealed"
              @decided="onDecided" />
          </template>
        </div>
        <aside class="detail-pane" aria-label="Selected posting">
          <PostingCard
            v-if="selected"
            :key="selected.key"
            :posting="selected"
            :config="config"
            :access-token="accessToken"
            :comp-floor="compFloor"
            :product-words="productWords"
            expanded
            :expandable="false"
            :actionable="false"
            :revealed="isRevealed(selected.key)"
            @revealed="onRevealed"
            @decided="onDecided" />
        </aside>
      </div>
      <Toast :toast="toast" />
    </section>
  `,
});
