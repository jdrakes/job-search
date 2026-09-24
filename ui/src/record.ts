/**
 * The record: every posting the processor kept, in any status. Filtering
 * runs over what the shell handed down, which is the last round with
 * whatever James has decided since laid over it, so a row states its new
 * status the moment its write lands.
 */
import { computed, defineComponent, ref, type PropType } from "vue";

import { STATUSES, type PostingSummary, type Status } from "../../src/schema.ts";
import type { AppConfig } from "./config.ts";
import { EmptyState } from "./empty-state.ts";
import { useMasterDetail } from "./master-detail.ts";
import { labelOf, outcomeToastText, PostingCard, type DecidedOutcome } from "./posting.ts";
import { byMostRecentAct, orderedQueue } from "./queue.ts";
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

/** Acted-on postings first, most recent `status_at` first; the rest in score order. */
export function orderedRecord(
  postings: readonly PostingSummary[],
  compFloor: number | null,
  nowMs: number,
  productWords: readonly string[] = [],
): PostingSummary[] {
  const acted = postings.filter((posting) => posting.status_at !== null).sort(byMostRecentAct);
  const untouched = orderedQueue(
    postings.filter((posting) => posting.status_at === null),
    compFloor,
    nowMs,
    productWords,
  );
  return [...acted, ...untouched];
}

/*
 * The two text filters bind `:value` + `@input`, not `v-model`: `v-model`
 * drops input events during a composition, and iOS marks autocorrect
 * candidates that way, so typing on an iPhone would narrow nothing.
 * Autocorrect is off on both: a company name is not a word to fix.
 */
export const RecordView = defineComponent({
  name: "RecordView",
  components: { PostingCard, EmptyState, Toast },
  props: {
    postings: { type: Array as PropType<PostingSummary[]>, required: true },
    config: { type: Object as PropType<AppConfig>, required: true },
    accessToken: { type: String, required: true },
    // Null when the criteria read failed; no card then guesses one.
    compFloor: { type: [Number, null] as PropType<number | null>, required: true },
    productWords: { type: Array as PropType<readonly string[]>, default: () => [] },
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
      ),
    );
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
        <div class="list" @keydown="onListKeydown">
          <PostingCard
            v-for="posting in filtered"
            :key="posting.key"
            :posting="posting"
            :config="config"
            :access-token="accessToken"
            :comp-floor="compFloor"
            :product-words="productWords"
            :selected="paneMode && selected !== null && posting.key === selected.key"
            :expandable="!paneMode"
            :revealed="isRevealed(posting.key)"
            @activated="selectedKey = $event"
            @revealed="onRevealed"
            @decided="onDecided" />
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
