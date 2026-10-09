/**
 * The priority queue: highest score first, ties by comp-band midpoint, then
 * `posted_at`, or newest first. With no criteria row there is no score and
 * the midpoint order stands alone. In the company view it also shows each
 * company's acted-on postings as history. The number waiting is the Queue
 * tab's count; a filtered count sits beside the search box and score filter
 * that narrowed it.
 */
import { computed, defineComponent, nextTick, ref, type PropType } from "vue";

import type { PostingSummary } from "../../src/schema.ts";
import type { SessionStore } from "./auth.ts";
import {
  ArrangeBar,
  loadArrangement,
  QUEUE_SORTS,
  saveSort,
  saveView,
  type ListView,
  type Sort,
} from "./arrange.ts";
import { countsByCompany } from "./companies.ts";
import type { AppConfig } from "./config.ts";
import { EmptyState } from "./empty-state.ts";
import { useMasterDetail } from "./master-detail.ts";
import {
  midpoint,
  nextSelection,
  outcomeToastText,
  PostingCard,
  scoreOf,
  type DecidedOutcome,
} from "./posting.ts";
import { SearchBox } from "./search-box.ts";
import { contains } from "./text-match.ts";
import { Toast, useToast } from "./toast.ts";

function comparePostedAt(a: PostingSummary, b: PostingSummary): number {
  if (a.posted_at === null && b.posted_at === null) return 0;
  if (a.posted_at === null) return 1;
  if (b.posted_at === null) return -1;
  return b.posted_at.localeCompare(a.posted_at);
}

function compareMidpoint(a: PostingSummary, b: PostingSummary): number {
  const am = midpoint(a);
  const bm = midpoint(b);
  if (am === null && bm === null) return comparePostedAt(a, b);
  if (am === null) return 1;
  if (bm === null) return -1;
  if (am !== bm) return bm - am;
  return comparePostedAt(a, b);
}

/** The default sort: score descending with a floor, comp-band midpoint descending without one. */
function compareByScore(
  postings: readonly PostingSummary[],
  compFloor: number | null,
  productWords: readonly string[],
): (a: PostingSummary, b: PostingSummary) => number {
  if (compFloor === null) return compareMidpoint;
  const scores = new Map(
    postings.map((posting) => [posting.key, scoreOf(posting, compFloor, productWords)]),
  );
  return (a, b) => {
    const diff = (scores.get(b.key) ?? 0) - (scores.get(a.key) ?? 0);
    return diff !== 0 ? diff : compareMidpoint(a, b);
  };
}

/** Most recent act first: the Record's default sort and a company's history under the Queue's company header. */
export function byMostRecentAct(a: PostingSummary, b: PostingSummary): number {
  return (b.status_at ?? "").localeCompare(a.status_at ?? "");
}

/**
 * The rows in the chosen sort. "acted" is the Record's own: the acted-on
 * rows first, most recent act first, then the untouched ones by score.
 * "posted" is newest first, a posting with no board date last, ties by score.
 */
export function sortedPostings(
  postings: readonly PostingSummary[],
  sort: Sort,
  compFloor: number | null,
  productWords: readonly string[] = [],
): PostingSummary[] {
  const byScore = compareByScore(postings, compFloor, productWords);
  if (sort === "score") return [...postings].sort(byScore);
  if (sort === "acted") {
    const acted = postings.filter((posting) => posting.status_at !== null).sort(byMostRecentAct);
    const untouched = postings.filter((posting) => posting.status_at === null).sort(byScore);
    return [...acted, ...untouched];
  }
  return [...postings].sort((a, b) => {
    const diff = comparePostedAt(a, b);
    return diff !== 0 ? diff : byScore(a, b);
  });
}

/**
 * Companies in the order their first sorted row earned, each company's rows
 * in that same order, and `history` after them, most recent act first. A
 * history row only joins a bucket `sorted` opened: in the Queue a company
 * with nothing waiting does not appear. One flat array, since selection,
 * "next after decided" and the arrow-key scan are index-based over it.
 */
export function groupedByCompany(
  sorted: readonly PostingSummary[],
  history: readonly PostingSummary[] = [],
): PostingSummary[] {
  const byCompany = new Map<string, PostingSummary[]>();
  for (const posting of sorted) {
    const held = byCompany.get(posting.company);
    if (held === undefined) byCompany.set(posting.company, [posting]);
    else held.push(posting);
  }
  for (const posting of [...history].sort(byMostRecentAct)) {
    byCompany.get(posting.company)?.push(posting);
  }
  return [...byCompany.values()].flat();
}

/** `acted` is read by the company view alone: the list view is what is still waiting and nothing else. */
export function orderedQueue(
  postings: readonly PostingSummary[],
  compFloor: number | null,
  productWords: readonly string[] = [],
  sort: Sort = "score",
  view: ListView = "list",
  acted: readonly PostingSummary[] = [],
): PostingSummary[] {
  const sorted = sortedPostings(postings, sort, compFloor, productWords);
  return view === "company" ? groupedByCompany(sorted, acted) : sorted;
}

/** The header a company's group opens with: rows still waiting on James, roles he has applied to, and roles he closed. */
export interface CompanyHead {
  readonly company: string;
  readonly waiting: number;
  readonly applied: number;
  readonly closed: number;
}

/**
 * `closed` is excluded: closing a posting is James rejecting it, not
 * applying. A company with no acted-on posting is absent from the map.
 */
export function appliedCountsByCompany(
  postings: readonly PostingSummary[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const posting of postings) {
    if (posting.status === null || posting.status === "closed") continue;
    counts.set(posting.company, (counts.get(posting.company) ?? 0) + 1);
  }
  return counts;
}

export interface QueueRow {
  readonly posting: PostingSummary;
  readonly head: CompanyHead | null;
  readonly history: boolean;
}

/**
 * A row opens a group when the row before it is a different company;
 * headers and rows render as siblings in one `.list` so the arrow-key scan
 * crosses company boundaries. The counts are read off the rows under the
 * header, so the search box, a filter and a decision move them with no
 * reload. `history` marks the acted rows the Queue's company view appended;
 * it is never true in the list view, nor in the Record, where every row is
 * the record and none is history.
 */
export function queueRows(
  postings: readonly PostingSummary[],
  grouped: boolean,
  actedAsHistory = true,
): QueueRow[] {
  if (!grouped) return postings.map((posting) => ({ posting, head: null, history: false }));
  const waiting = countsByCompany(postings.filter((posting) => posting.status === null));
  const applied = appliedCountsByCompany(postings);
  const closed = countsByCompany(postings.filter((posting) => posting.status === "closed"));
  return postings.map((posting, at) => ({
    posting,
    head:
      postings[at - 1]?.company === posting.company
        ? null
        : {
            company: posting.company,
            waiting: waiting.get(posting.company) ?? 0,
            applied: applied.get(posting.company) ?? 0,
            closed: closed.get(posting.company) ?? 0,
          },
    history: actedAsHistory && posting.status !== null,
  }));
}

/** The rows with no status, the number in the header James acts on. Only called for a count above zero. */
export function waitingLabel(count: number): string {
  return `${count} waiting`;
}

/** "1 applied", not "applied to 1": beside a waiting count the latter reads as "1 of those". Only called for a count above zero. */
export function appliedLabel(count: number): string {
  return `${count} applied`;
}

/**
 * Waiting and applied, whichever are above zero. In the Queue a group only
 * opens on a waiting row, so its header always says the waiting count. In
 * the Record a company can have neither, every role closed, and its header
 * says that instead of nothing.
 */
export function companyHeadLabel(head: CompanyHead): string {
  const parts = [
    ...(head.waiting > 0 ? [waitingLabel(head.waiting)] : []),
    ...(head.applied > 0 ? [appliedLabel(head.applied)] : []),
  ];
  return parts.length > 0 ? parts.join(" · ") : `${head.closed} closed`;
}

/**
 * Which companies' groups are folded to their header. Not remembered, like
 * the search box: a fold restored tomorrow would hide the roles that arrived
 * overnight under a header he no longer remembers closing. A folded company
 * keeps its header and counts, so what is under it is still said; only its
 * rows leave the list, and with them the arrow-key scan, which reads the
 * rendered `.card .head`s.
 */
export function useCollapsedCompanies(): {
  isCollapsed(company: string): boolean;
  toggleCompany(company: string): void;
} {
  const collapsed = ref<ReadonlySet<string>>(new Set());
  function toggleCompany(company: string): void {
    const next = new Set(collapsed.value);
    if (!next.delete(company)) next.add(company);
    collapsed.value = next;
  }
  return { isCollapsed: (company) => collapsed.value.has(company), toggleCompany };
}

/**
 * The header's chevron: pointing right folded, turned down open by CSS on
 * the button's `aria-expanded`, so the one attribute drives both what a
 * screen reader hears and what the eye sees.
 */
export const FOLD_ICON = "M6 4l4 4-4 4";

/** Company or title, not both: which of the two a word hit is not a fact James wants back. */
export function matchesQuery(posting: PostingSummary, query: string): boolean {
  if (query.trim() === "") return true;
  return contains(posting.company, query) || contains(posting.title, query);
}

/** The floors the score filter offers; "Any" is the empty option before them. */
export const MIN_SCORES = [10, 20, 30, 40, 50, 60, 70, 80, 90] as const;

/**
 * At or above `minScore`. With no floor there is no score, so nothing is
 * filtered out: the control is hidden then, and a choice made before the
 * criteria read failed must not empty the queue on a number it cannot show.
 */
export function meetsMinScore(
  posting: PostingSummary,
  minScore: number | null,
  compFloor: number | null,
  productWords: readonly string[] = [],
): boolean {
  if (minScore === null || compFloor === null) return true;
  return scoreOf(posting, compFloor, productWords) >= minScore;
}

/**
 * The rows only: above the master-detail breakpoint the pane renders the
 * selected posting as a `.card` in the same container. `Array.from`, not
 * `for...of`: `ui/tsconfig.json` targets a `NodeListOf` with no iterator.
 */
function cardsIn(container: HTMLElement | null): HTMLElement[] {
  if (container === null) return [];
  const list = container.querySelector<HTMLElement>(".list") ?? container;
  return Array.from(list.querySelectorAll<HTMLElement>(".card"));
}

/**
 * The head button of the row showing `key`, or null. After a decision the
 * list has re-ordered, so the card's `data-key` is what still names a row.
 * Compared as `dataset.key`: an attribute selector would need `CSS.escape`,
 * a browser global.
 */
export function headOf(list: HTMLElement | null, key: string | null): HTMLElement | null {
  if (key === null) return null;
  const card = cardsIn(list).find((each) => each.dataset["key"] === key);
  return card?.querySelector<HTMLElement>(".head") ?? null;
}

/**
 * The head of whatever row now sits at `index`, clamped to the last row: for
 * the decision that takes its row off screen and leaves no key to find.
 * Null for an empty list or a negative index.
 */
export function headAt(list: HTMLElement | null, index: number): HTMLElement | null {
  if (index < 0) return null;
  const cards = cardsIn(list);
  if (cards.length === 0) return null;
  const card = cards[Math.min(index, cards.length - 1)];
  return card?.querySelector<HTMLElement>(".head") ?? null;
}

/** For renders before a session exists, and most tests. */
export const NULL_STORE: SessionStore = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

/**
 * The statuses a company's history in the Queue shows: the roles still live
 * for James. Rejected and closed are ends; under a company he is deciding on
 * they are roles that will not move again, and they read as noise beside the
 * ones that can (2026-10-01). The Record keeps every status: it is the
 * record.
 */
export const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["applied", "interviewing", "offer"]);

export function isActive(posting: PostingSummary): boolean {
  return posting.status !== null && ACTIVE_STATUSES.has(posting.status);
}

/**
 * Every posting this view should show as history, grouped by company: the
 * active ones only (`isActive`). Normally `history` is all of it: both reads return a queue row, so a
 * posting decided on this page comes back from the record read wearing its
 * new status. But when the record read fails `history` is empty while the
 * queue read is fine, and a row James just decided would then be in neither
 * half: excluded from `waiting` by its own patch, and absent from history.
 * It would leave the Queue with nothing on the tab saying why. Taking the
 * decided rows off the queue side as well covers that, deduped by key: both
 * reads holding the same posting must still render one card under its
 * company, not two.
 */
function actedWith(
  history: readonly PostingSummary[],
  postings: readonly PostingSummary[],
): PostingSummary[] {
  const known = new Set(history.map((posting) => posting.key));
  return [
    ...history,
    ...postings.filter((posting) => posting.status !== null && !known.has(posting.key)),
  ].filter(isActive);
}

/**
 * Companies where James has an application still open (`isActive`): the
 * ones the "No open application" filter takes out of the Queue, so the
 * companies he has not yet reached can be applied to first.
 */
export function companiesWithOpenApplication(
  postings: readonly PostingSummary[],
): ReadonlySet<string> {
  return new Set(postings.filter(isActive).map((posting) => posting.company));
}

export const QueueView = defineComponent({
  name: "QueueView",
  components: { ArrangeBar, PostingCard, EmptyState, SearchBox, Toast },
  props: {
    postings: { type: Array as PropType<PostingSummary[]>, required: true },
    config: { type: Object as PropType<AppConfig>, required: true },
    accessToken: { type: String, required: true },
    // Null when the criteria read failed; no card then guesses one.
    compFloor: { type: [Number, null] as PropType<number | null>, required: true },
    productWords: { type: Array as PropType<readonly string[]>, default: () => [] },
    // Where the chosen view and sort are remembered across a reload.
    store: { type: Object as PropType<SessionStore>, default: () => NULL_STORE },
    // The record's postings, handed in by `app.ts`, which is where a
    // posting decided on this page has already been given its new status;
    // the company view shows them as each company's history, the list view
    // never reads them.
    history: { type: Array as PropType<PostingSummary[]>, default: () => [] },
  },
  emits: {
    // Handed up to `AppRoot`, which lays the patch over both reads; this
    // view keeps no copy of its own.
    decided: (_outcome: DecidedOutcome) => true,
  },
  setup(props, { emit }) {
    const initial = loadArrangement(props.store, "queue", QUEUE_SORTS);
    const view = ref<ListView>(initial.view);
    const sort = ref<Sort>(initial.sort);
    function setView(next: ListView): void {
      view.value = next;
      saveView(props.store, "queue", next);
    }
    function setSort(next: Sort): void {
      sort.value = next;
      saveSort(props.store, "queue", next);
    }
    const { toast, showToast } = useToast();
    // After a decision the focused control goes away (the row leaves the flat
    // orders; grouped it re-renders with other outcomes), so focus would fall
    // to `<body>` (WCAG 2.4.3). It re-homes to the row that takes the decided
    // one's place, not the panel: `focus()` scrolls to its target and the
    // panel begins above the list. The panel is the last resort, for the
    // decision that empties the queue; its tab names it, so landing there
    // says "Queue" rather than nothing.
    const listRef = ref<HTMLElement | null>(null);
    const sectionRef = ref<HTMLElement | null>(null);
    // Not remembered, unlike the view and sort: a filter restored tomorrow would open
    // the list on a queue silently missing most of itself. `:value` +
    // `@input` rather than `v-model`, as in the Record: `v-model` drops input
    // events during a composition, and iOS marks autocorrect candidates as one.
    const query = ref("");
    // Not remembered either, for the same reason as the box.
    const minScore = ref<number | null>(null);
    function setMinScore(value: string): void {
      minScore.value = value === "" ? null : Number(value);
    }
    // Not remembered either: restored tomorrow it would hide every company
    // he applied to today with nothing on screen but the box saying why.
    const noOpenApplication = ref(false);
    const acted = computed(() => actedWith(props.history, props.postings));
    const openCompanies = computed(() => companiesWithOpenApplication(acted.value));
    const filtering = computed(
      () =>
        query.value.trim() !== "" ||
        (minScore.value !== null && props.compFloor !== null) ||
        noOpenApplication.value,
    );
    /** Waiting on James: no status, whether the store wrote it or he just did. */
    const isWaiting = (posting: PostingSummary): boolean => posting.status === null;
    // What the filtered count is measured against, and the one predicate both
    // numbers come off, so the pair cannot drift.
    const waitingTotal = computed(() => props.postings.filter(isWaiting));
    // The empty state and the grouped headers read this, not the rows on
    // screen. Filtering `waiting` rather than the rows is what makes the
    // grouped headers follow the box: a group only opens for a company with
    // something waiting.
    const waiting = computed(() =>
      waitingTotal.value.filter(
        (posting) =>
          matchesQuery(posting, query.value) &&
          meetsMinScore(posting, minScore.value, props.compFloor, props.productWords) &&
          !(noOpenApplication.value && openCompanies.value.has(posting.company)),
      ),
    );
    /*
     * The filtered count, and "" when no filter is set. The `<p>` that shows
     * it is always in the tree rather than conditional on the query: it is a
     * live region, and one inserted with its text already in it is announced
     * unreliably (the note above `.sr-only` in `ui/app.css`), so the first
     * number he typed for would be the one he never heard, and clearing the
     * box would say nothing at all. The element stays; only its text comes
     * and goes. Unfiltered the tab's own pill already says the number.
     */
    const matchedText = computed(() =>
      filtering.value ? `${waiting.value.length} of ${waitingTotal.value.length}` : "",
    );
    const visible = computed(() =>
      orderedQueue(
        waiting.value,
        props.compFloor,
        props.productWords,
        sort.value,
        view.value,
        acted.value,
      ),
    );
    const rows = computed(() => queueRows(visible.value, view.value === "company"));
    const { isCollapsed, toggleCompany } = useCollapsedCompanies();
    // An empty queue and an empty result are different facts.
    const emptyText = computed(() =>
      filtering.value ? "Nothing matches." : "Nothing waiting on you.",
    );
    const {
      selectedKey,
      selected,
      paneMode,
      onListKeydown,
      advanceSelection,
      onRevealed,
      isRevealed,
    } = useMasterDetail(visible);
    function onDecided(outcome: DecidedOutcome): void {
      // All three read `visible` before the emitted patch re-orders it.
      advanceSelection(outcome.key);
      const successor = nextSelection(visible.value, outcome.key);
      const wasAt = visible.value.findIndex((posting) => posting.key === outcome.key);
      emit("decided", outcome);
      showToast(outcomeToastText(outcome.patch.status, outcome.company));
      // After the re-render, or the row being focused is the one leaving.
      void nextTick(() => {
        const target =
          // The row that takes the decided one's place.
          headOf(listRef.value, successor) ??
          // Grouped, the decided row moved into its company's history.
          headOf(listRef.value, outcome.key) ??
          // Grouped, deciding a company's last waiting row closes its group,
          // taking the successor with it; whatever slid into that position is
          // the nearest row.
          headAt(listRef.value, wasAt) ??
          // Nothing left to hold it: the queue is empty, and its panel is
          // what is left that a screen reader can name.
          sectionRef.value;
        target?.focus();
      });
    }
    return {
      waiting,
      matchedText,
      rows,
      companyHeadLabel,
      paneMode,
      selected,
      selectedKey,
      isRevealed,
      onRevealed,
      onDecided,
      onListKeydown,
      listRef,
      sectionRef,
      toast,
      view,
      sort,
      setView,
      setSort,
      QUEUE_SORTS,
      query,
      minScore,
      setMinScore,
      MIN_SCORES,
      noOpenApplication,
      emptyText,
      isCollapsed,
      toggleCompany,
      FOLD_ICON,
    };
  },
  template: `
    <section role="tabpanel" id="panel-queue" aria-labelledby="tab-queue" tabindex="-1" ref="sectionRef">
      <ArrangeBar tab="queue" tab-label="Queue" :view="view" :sort="sort" :sorts="QUEUE_SORTS" @view="setView" @sort="setSort" />
      <div class="queue-search">
        <SearchBox :value="query" placeholder="Company or role" @search="query = $event" />
        <label v-if="compFloor !== null" class="min-score">
          <span>Min score</span>
          <select :value="minScore === null ? '' : String(minScore)" @change="setMinScore($event.target.value)">
            <option value="">Any</option>
            <option v-for="s in MIN_SCORES" :key="s" :value="String(s)">{{ s }}+</option>
          </select>
        </label>
        <label class="no-open">
          <input type="checkbox" :checked="noOpenApplication" @change="noOpenApplication = $event.target.checked" />
          <span>No open application</span>
        </label>
        <p class="matched" role="status">{{ matchedText }}</p>
      </div>
      <EmptyState v-if="waiting.length === 0" :text="emptyText" />
      <div class="master-detail" v-else ref="listRef">
        <TransitionGroup tag="div" name="list" class="list" :class="{ grouped: view === 'company' }" @keydown="onListKeydown">
          <template v-for="row in rows" :key="row.posting.key">
            <h2 v-if="row.head !== null" class="company-head"><button type="button" class="company-toggle" :aria-expanded="!isCollapsed(row.head.company)" @click="toggleCompany(row.head.company)"><svg class="fold" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="FOLD_ICON" /></svg><span class="company">{{ row.head.company }}</span> &mdash; {{ companyHeadLabel(row.head) }}</button></h2>
            <PostingCard
              v-if="!isCollapsed(row.posting.company)"
              :class="{ history: row.history }"
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
        </TransitionGroup>
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
