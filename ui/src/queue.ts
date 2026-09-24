/**
 * The priority queue: highest score first, ties by comp-band midpoint, then
 * `posted_at`. With no criteria row there is no score and the midpoint order
 * stands alone. Grouped by company it also shows each company's acted-on
 * postings as history. The number waiting is the Queue tab's count; a
 * filtered count sits beside the search box that narrowed it.
 */
import { computed, defineComponent, nextTick, ref, type PropType } from "vue";

import type { PostingSummary } from "../../src/schema.ts";
import type { SessionStore } from "./auth.ts";
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

export const QUEUE_ORDERS = ["score", "posted", "company"] as const;
export type QueueOrder = (typeof QUEUE_ORDERS)[number];

export const QUEUE_ORDER_KEY = "queue-order";

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

/** Today's default order: score descending with a floor, comp-band midpoint descending without one. */
function compareByScore(
  postings: readonly PostingSummary[],
  compFloor: number | null,
  nowMs: number,
  productWords: readonly string[],
): (a: PostingSummary, b: PostingSummary) => number {
  if (compFloor === null) return compareMidpoint;
  const scores = new Map(
    postings.map((posting) => [posting.key, scoreOf(posting, compFloor, nowMs, productWords)]),
  );
  return (a, b) => {
    const diff = (scores.get(b.key) ?? 0) - (scores.get(a.key) ?? 0);
    return diff !== 0 ? diff : compareMidpoint(a, b);
  };
}

/** Most recent act first: the Record's order and a company's history under the grouped queue's header. */
export function byMostRecentAct(a: PostingSummary, b: PostingSummary): number {
  return (b.status_at ?? "").localeCompare(a.status_at ?? "");
}

/**
 * Companies in the order their best waiting posting earned, each company's
 * waiting rows by score and its acted rows after them as history. A company
 * with nothing waiting does not appear: the acted rows only join a bucket
 * the waiting pass opened. One flat array, since selection, "next after
 * decided" and the arrow-key scan are index-based over it.
 */
function groupedByCompany(
  waiting: readonly PostingSummary[],
  acted: readonly PostingSummary[],
  byScore: (a: PostingSummary, b: PostingSummary) => number,
): PostingSummary[] {
  const byCompany = new Map<string, PostingSummary[]>();
  for (const posting of [...waiting].sort(byScore)) {
    const held = byCompany.get(posting.company);
    if (held === undefined) byCompany.set(posting.company, [posting]);
    else held.push(posting);
  }
  for (const posting of [...acted].sort(byMostRecentAct)) {
    byCompany.get(posting.company)?.push(posting);
  }
  return [...byCompany.values()].flat();
}

/** `acted` is read by the "company" order alone: the flat orders are what is still waiting and nothing else. */
export function orderedQueue(
  postings: readonly PostingSummary[],
  compFloor: number | null,
  nowMs: number,
  productWords: readonly string[] = [],
  order: QueueOrder = "score",
  acted: readonly PostingSummary[] = [],
): PostingSummary[] {
  const byScore = compareByScore(postings, compFloor, nowMs, productWords);
  if (order === "score") return [...postings].sort(byScore);
  if (order === "company") return groupedByCompany(postings, acted, byScore);
  // Newest first; a posting with no board date sorts last. Ties fall back
  // to the score order.
  return [...postings].sort((a, b) => {
    const diff = comparePostedAt(a, b);
    return diff !== 0 ? diff : byScore(a, b);
  });
}

/** The header a company's group opens with: rows still waiting on James, and roles he has applied to. */
export interface CompanyHead {
  readonly company: string;
  readonly waiting: number;
  readonly applied: number;
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
 * crosses company boundaries. Both counts are read off the rows under the
 * header, so the search box and a decision move them with no reload; a
 * closed role is in neither. `history` marks the acted rows grouped mode
 * appended, never true in the flat orders.
 */
export function queueRows(postings: readonly PostingSummary[], grouped: boolean): QueueRow[] {
  if (!grouped) return postings.map((posting) => ({ posting, head: null, history: false }));
  const waiting = countsByCompany(postings.filter((posting) => posting.status === null));
  const applied = appliedCountsByCompany(postings);
  return postings.map((posting, at) => ({
    posting,
    head:
      postings[at - 1]?.company === posting.company
        ? null
        : {
            company: posting.company,
            waiting: waiting.get(posting.company) ?? 0,
            applied: applied.get(posting.company) ?? 0,
          },
    history: posting.status !== null,
  }));
}

/** The rows with no status, the one number in the header James acts on. Never zero: a group only opens on a waiting row. */
export function waitingLabel(count: number): string {
  return `${count} waiting`;
}

/** "1 applied", not "applied to 1": beside a waiting count the latter reads as "1 of those". Only called for a count above zero. */
export function appliedLabel(count: number): string {
  return `${count} applied`;
}

export function companyHeadLabel(head: CompanyHead): string {
  return head.applied > 0
    ? `${waitingLabel(head.waiting)} · ${appliedLabel(head.applied)}`
    : waitingLabel(head.waiting);
}

/** Company or title, not both: which of the two a word hit is not a fact James wants back. */
export function matchesQuery(posting: PostingSummary, query: string): boolean {
  if (query.trim() === "") return true;
  return contains(posting.company, query) || contains(posting.title, query);
}

function isQueueOrder(value: string): value is QueueOrder {
  return (QUEUE_ORDERS as readonly string[]).includes(value);
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

export function loadQueueOrder(store: SessionStore): QueueOrder {
  const stored = store.getItem(QUEUE_ORDER_KEY);
  return stored !== null && isQueueOrder(stored) ? stored : "score";
}

/** A failed write (quota, private browsing) must not break the page. */
export function saveQueueOrder(store: SessionStore, order: QueueOrder): void {
  try {
    store.setItem(QUEUE_ORDER_KEY, order);
  } catch {
    // Unremembered; the in-memory order the page is already showing stands.
  }
}

/** For renders before a session exists, and most tests. */
const NULL_STORE: SessionStore = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

/**
 * Every posting this view should show as history, grouped by company.
 * Normally `history` is all of it: both reads return a queue row, so a
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
  ];
}

export const QueueView = defineComponent({
  name: "QueueView",
  components: { PostingCard, EmptyState, SearchBox, Toast },
  props: {
    postings: { type: Array as PropType<PostingSummary[]>, required: true },
    config: { type: Object as PropType<AppConfig>, required: true },
    accessToken: { type: String, required: true },
    // Null when the criteria read failed; no card then guesses one.
    compFloor: { type: [Number, null] as PropType<number | null>, required: true },
    productWords: { type: Array as PropType<readonly string[]>, default: () => [] },
    // Where the chosen order is remembered across a reload.
    store: { type: Object as PropType<SessionStore>, default: () => NULL_STORE },
    // The record's postings, handed in by `app.ts`, which is where a
    // posting decided on this page has already been given its new status;
    // grouped mode shows them as each company's history, the flat orders
    // never read them.
    history: { type: Array as PropType<PostingSummary[]>, default: () => [] },
  },
  emits: {
    // Handed up to `AppRoot`, which lays the patch over both reads; this
    // view keeps no copy of its own.
    decided: (_outcome: DecidedOutcome) => true,
  },
  setup(props, { emit }) {
    const order = ref<QueueOrder>(loadQueueOrder(props.store));
    function setOrder(next: QueueOrder): void {
      order.value = next;
      saveQueueOrder(props.store, next);
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
    // Not remembered, unlike the order: a filter restored tomorrow would open
    // the list on a queue silently missing most of itself. `:value` +
    // `@input` rather than `v-model`, as in the Record: `v-model` drops input
    // events during a composition, and iOS marks autocorrect candidates as one.
    const query = ref("");
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
      waitingTotal.value.filter((posting) => matchesQuery(posting, query.value)),
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
      query.value.trim() === "" ? "" : `${waiting.value.length} of ${waitingTotal.value.length}`,
    );
    const visible = computed(() =>
      orderedQueue(
        waiting.value,
        props.compFloor,
        Date.now(),
        props.productWords,
        order.value,
        actedWith(props.history, props.postings),
      ),
    );
    const rows = computed(() => queueRows(visible.value, order.value === "company"));
    // An empty queue and an empty result are different facts.
    const emptyText = computed(() =>
      query.value.trim() === "" ? "Nothing waiting on you." : "Nothing matches.",
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
      order,
      setOrder,
      query,
      emptyText,
    };
  },
  template: `
    <section role="tabpanel" id="panel-queue" aria-labelledby="tab-queue" tabindex="-1" ref="sectionRef">
      <div class="order" role="group" aria-label="Queue order">
        <button type="button" :class="{ primary: order === 'score' }" :aria-pressed="order === 'score'" @click="setOrder('score')">By score</button>
        <button type="button" :class="{ primary: order === 'posted' }" :aria-pressed="order === 'posted'" @click="setOrder('posted')">Newest first</button>
        <button type="button" :class="{ primary: order === 'company' }" :aria-pressed="order === 'company'" @click="setOrder('company')">Group by company</button>
      </div>
      <div class="queue-search">
        <SearchBox :value="query" placeholder="Company or role" @search="query = $event" />
        <p class="matched" role="status">{{ matchedText }}</p>
      </div>
      <EmptyState v-if="waiting.length === 0" :text="emptyText" />
      <div class="master-detail" v-else ref="listRef">
        <TransitionGroup tag="div" name="list" class="list" :class="{ grouped: order === 'company' }" @keydown="onListKeydown">
          <template v-for="row in rows" :key="row.posting.key">
            <h2 v-if="row.head !== null" class="company-head"><span class="company">{{ row.head.company }}</span> &mdash; {{ companyHeadLabel(row.head) }}</h2>
            <PostingCard
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
