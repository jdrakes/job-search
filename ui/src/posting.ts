import {
  computed,
  defineComponent,
  nextTick,
  onBeforeUnmount,
  ref,
  useId,
  watch,
  type PropType,
  type Ref,
} from "vue";

import { STATUSES, type PostingSummary, type Status } from "../../src/schema.ts";
import { findWholeWord } from "../../src/judge/whole-word.ts";
import { setStatus, type StatusPatch } from "./api.ts";
import type { AppConfig } from "./config.ts";
import { focusAfterClose, trapFocus, type DialogClose } from "./focus-trap.ts";

const STATUS_LABELS: Record<Status, string> = {
  applied: "Applied",
  interviewing: "Interviewing",
  rejected: "Rejected",
  offer: "Offer",
  closed: "Closed",
};

export function labelOf(status: Status): string {
  return STATUS_LABELS[status];
}

export function outcomeToastText(status: Status, company: string): string {
  return `${labelOf(status)} — ${company}`;
}

/**
 * The whole patch, not the status alone: the Record lays it over its copy
 * of the row, and the next patch from that row reads `applied_at` back.
 */
export interface DecidedOutcome {
  readonly key: string;
  readonly company: string;
  readonly patch: StatusPatch;
}

export function decidedOutcome(posting: PostingSummary, patch: StatusPatch): DecidedOutcome {
  return { key: posting.key, company: posting.company, patch };
}

/** Inline SVG paths on a 16-unit grid, stroked in the current colour. */
const ACT_ICONS: Record<Status, string> = {
  applied: "M3 8.5l3 3 7-7",
  interviewing: "M2.5 4.5h11v9h-11zM2.5 7.5h11M5.5 2v3M10.5 2v3",
  rejected: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4",
  offer: "M8 2l1.8 3.7 4.1.6-3 2.9.7 4.1L8 11.4l-3.6 1.9.7-4.1-3-2.9 4.1-.6z",
  closed: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM3.8 12.2l8.4-8.4",
};

export function iconOf(status: Status): string {
  return ACT_ICONS[status];
}

/** A pencil, on the same 16-unit grid as `ACT_ICONS`. */
export const CHANGE_ICON = "M11 2.5l2.5 2.5-7 7-3 .5.5-3z";

/** The status dot's colour (`app.css` `.tone-*`). */
const STATUS_TONE: Record<Status, string> = {
  applied: "progress",
  interviewing: "progress",
  offer: "success",
  rejected: "danger",
  closed: "neutral",
};

export function toneOf(status: Status): string {
  return STATUS_TONE[status];
}

export function statusTag(status: Status | null): {
  readonly label: string;
  readonly tone: string;
} {
  return status === null
    ? { label: "In queue", tone: "neutral" }
    : { label: labelOf(status), tone: toneOf(status) };
}

/** A bare date with no time or offset: `posted_at`, `applied_at`, `status_at` are Postgres `date` columns. */
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whole days between an ISO timestamp and `nowMs`; never negative.
 *
 * `Date.parse` reads a bare date as UTC midnight, which from any negative
 * UTC offset is still hours ahead of local midnight, so a posting dated
 * today would look a day old for the last hours of each local day.
 * Appending a bare local time makes it resolve to local midnight instead.
 * A full timestamp carries its own offset and is parsed unchanged.
 */
export function daysBetween(fromIso: string, nowMs: number): number {
  const from = BARE_DATE.test(fromIso) ? new Date(`${fromIso}T00:00:00`) : new Date(fromIso);
  return Math.max(0, Math.floor((nowMs - from.getTime()) / 86_400_000));
}

export function ageLabel(days: number): string {
  if (days === 0) return "since today";
  return days === 1 ? "for 1 day" : `for ${days} days`;
}

/** Worded differently from `ageLabel` so the two facts are never mistaken for each other on the card. */
export function postedAgeLabel(days: number): string {
  if (days === 0) return "posted today";
  return days === 1 ? "posted 1 day ago" : `posted ${days} days ago`;
}

/** Null when the posting carries no band; the queue sorts a null to the floor rather than treating it as zero. */
export function midpoint(posting: PostingSummary): number | null {
  const { comp_low, comp_high } = posting;
  if (comp_low !== null && comp_high !== null) return (comp_low + comp_high) / 2;
  if (comp_low !== null) return comp_low;
  if (comp_high !== null) return comp_high;
  return null;
}

/*
 * A steeper scale (full pay at twice the floor, freshness gone in a month)
 * scores most of the queue at 0: most rows post no band and few midpoints
 * reach twice the floor.
 */
export const PAY_WEIGHT = 70;
export const FRESHNESS_WEIGHT = 30;
export const FRESH_DAYS = 90;
/** Full pay marks at floor × (1 + PAY_REACH). */
export const PAY_REACH = 0.5;
/** Low enough that a fresh unpriced row sits under every fresh priced row above the floor; at half marks, unpriced rows fill the top of the queue. */
export const UNPOSTED_PAY = 20;

/** Small: pay dominates and product rows already pay well. */
export const SHAPE_WEIGHT = 15;

/**
 * Score out of 100, a cue on the card and never the order.
 * `pay = PAY_WEIGHT × clamp((top − floor) / (floor × PAY_REACH), 0, 1)`,
 * UNPOSTED_PAY with no band; `freshness = FRESHNESS_WEIGHT × max(0, 1 −
 * ageDays / FRESH_DAYS)`. The top of the band, not the midpoint: the
 * processor admits a band when its top clears the floor, so a midpoint
 * would score an admitted band that straddles the floor at 0.
 *
 * With product words, pay and freshness scale into `100 − SHAPE_WEIGHT`
 * and a title carrying any of them whole-word adds `SHAPE_WEIGHT`. Title
 * only: the score orders, never excludes.
 */
export function scoreOf(
  posting: PostingSummary,
  compFloor: number,
  nowMs: number,
  productWords: readonly string[] = [],
): number {
  const pay = posting.comp_high ?? posting.comp_low;
  // A floor of 0 makes the ratio meaningless (0/0 is NaN); score it at the floor.
  const ratio = pay === null || compFloor <= 0 ? 0 : (pay - compFloor) / (compFloor * PAY_REACH);
  const payScore = pay === null ? UNPOSTED_PAY : PAY_WEIGHT * Math.max(0, Math.min(1, ratio));
  const ageDays = daysBetween(posting.posted_at ?? posting.first_seen, nowMs);
  const freshness = FRESHNESS_WEIGHT * Math.max(0, 1 - ageDays / FRESH_DAYS);
  if (productWords.length === 0) {
    return Math.round(payScore + freshness);
  }
  const scale = (100 - SHAPE_WEIGHT) / 100;
  const title = posting.title ?? "";
  const namesProduct = productWords.some((word) => findWholeWord(title, word) !== null);
  return Math.round((payScore + freshness) * scale + (namesProduct ? SHAPE_WEIGHT : 0));
}

export function formatComp(value: number): string {
  return `$${Math.round(value / 1000)}k`;
}

export function compLabel(posting: PostingSummary): string {
  const { comp_low, comp_high } = posting;
  if (comp_low !== null && comp_high !== null) {
    return comp_low === comp_high
      ? formatComp(comp_low)
      : `${formatComp(comp_low)}–${formatComp(comp_high)}`;
  }
  if (comp_low !== null) return formatComp(comp_low);
  if (comp_high !== null) return formatComp(comp_high);
  return "—";
}

/**
 * Only an http(s) URL: `Posting.url` is unvalidated text off an ATS
 * response and this page holds a JWT in `localStorage`, so a `javascript:`
 * URL bound into an `href` would run in this origin. The scheme is read off
 * a parsed URL, not matched as a prefix, which a leading newline or a
 * differently cased scheme gets past.
 */
export function postingHref(url: string | null): string | null {
  if (url === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : null;
}

export interface Reason {
  readonly criterion: string;
  readonly verdict: string;
  readonly detail: string;
}

/** `posting.reasons` is jsonb off the processor; malformed entries are dropped. */
export function reasonLines(reasons: readonly unknown[]): Reason[] {
  const lines: Reason[] = [];
  for (const raw of reasons) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const { criterion, verdict, detail } = record;
    if (
      typeof criterion === "string" &&
      typeof verdict === "string" &&
      typeof detail === "string"
    ) {
      lines.push({ criterion, verdict, detail });
    }
  }
  return lines;
}

export interface EvidenceLine {
  readonly fact: string;
  readonly detail: string;
}

/** `posting.evidence` is jsonb; only its string values are shown. */
export function evidenceLines(evidence: Readonly<Record<string, unknown>>): EvidenceLine[] {
  return Object.entries(evidence)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([fact, detail]) => ({ fact: fact.replace(/_/g, " "), detail }));
}

/** `applied_at` stamps only on Applied: a later status must not erase when James applied. */
export function patchFor(
  posting: PostingSummary,
  status: Status,
  note: string | null,
  now: string,
): StatusPatch {
  return {
    status,
    status_at: now,
    applied_at: status === "applied" ? now : posting.applied_at,
    note,
  };
}

export function closeRefusal(reason: string): string | null {
  return reason.trim() === "" ? "Say why — closing disagrees with the processor." : null;
}

/**
 * The outcomes a card offers from each status ("queue" for none). Rejected
 * and closed are ends and offer none; a card there renders the "change"
 * control instead, a per-card toggle this map does not decide.
 */
export const OUTCOMES_BY_STATUS = {
  queue: ["applied", "closed"],
  applied: ["interviewing", "rejected", "closed"],
  interviewing: ["offer", "rejected", "closed"],
  offer: ["closed"],
  rejected: [],
  closed: [],
} as const satisfies Record<Status | "queue", readonly Status[]>;

export function outcomesFor(status: Status | null): readonly Status[] {
  return OUTCOMES_BY_STATUS[status ?? "queue"];
}

/** The posting matching `selectedKey` if still present, else the top of the order: the initial auto-select and the self-heal when the selection leaves the list. */
export function resolveSelection(
  postings: readonly PostingSummary[],
  selectedKey: string | null,
): PostingSummary | null {
  const match = selectedKey === null ? undefined : postings.find((p) => p.key === selectedKey);
  return match ?? postings[0] ?? null;
}

/** After a decide: the next posting in the order, the one before it when the decided posting was last, null when there is none. */
export function nextSelection(
  postings: readonly PostingSummary[],
  decidedKey: string,
): string | null {
  const at = postings.findIndex((posting) => posting.key === decidedKey);
  if (at === -1) return null;
  return postings[at + 1]?.key ?? postings[at - 1]?.key ?? null;
}

/**
 * True from the master-detail breakpoint up. Read from the `--pane-mode`
 * flag `app.css` sets on `:root`, so the breakpoint lives in one place; a
 * view needs it in script because `aria-expanded` cannot be set by a
 * stylesheet. With no window (SSR tests) the answer is false.
 */
export function usePaneMode(): Ref<boolean> {
  const paneMode = ref(false);
  if (typeof window === "undefined") return paneMode;
  function read(): void {
    paneMode.value =
      getComputedStyle(document.documentElement).getPropertyValue("--pane-mode").trim() === "1";
  }
  read();
  window.addEventListener("resize", read);
  onBeforeUnmount(() => window.removeEventListener("resize", read));
  return paneMode;
}

export const PostingCard = defineComponent({
  name: "PostingCard",
  props: {
    posting: { type: Object as PropType<PostingSummary>, required: true },
    config: { type: Object as PropType<AppConfig>, required: true },
    accessToken: { type: String, required: true },
    // Null when there is no criteria row; the card then shows no score.
    compFloor: { type: [Number, null] as PropType<number | null>, required: true },
    productWords: { type: Array as PropType<readonly string[]>, default: () => [] },
    // Seeds the expansion; a test with no DOM to click renders the detail through it.
    expanded: { type: Boolean, default: false },
    // False for both cards of a master-detail split: the row's head only
    // selects, and the pane's card must stay open.
    expandable: { type: Boolean, default: true },
    // False for the pane of a master-detail split, whose row already carries them.
    actionable: { type: Boolean, default: true },
    // Opens all five outcomes on a rejected or closed posting. A prop so a
    // master-detail view can hold the answer per posting, outliving a card
    // it unmounts and remounts.
    revealed: { type: Boolean, default: false },
    // Seeds the close dialog open, for an SSR test with no DOM to click.
    closing: { type: Boolean, default: false },
    // The posting shown in a master-detail pane; the card only carries the
    // marker (`aria-current`, `.selected`).
    selected: { type: Boolean, default: false },
  },
  emits: {
    decided: (_outcome: DecidedOutcome) => true,
    // Fired on every head click, whatever it did to the expansion.
    activated: (_key: string) => true,
    revealed: (_key: string) => true,
  },
  setup(props, { emit }) {
    const expanded = ref(props.expanded);
    const revealedHere = ref(false);
    const busy = ref(false);
    const closing = ref(props.closing);
    const closeReason = ref("");
    const closeError = ref<string | null>(null);
    const panelRef = ref<HTMLElement | null>(null);
    // Set by `setFirstOutcomeRef` rather than a string ref: inside a `v-for`
    // Vue accumulates a string ref into an array.
    const firstOutcomeRef = ref<HTMLElement | null>(null);
    function setFirstOutcomeRef(el: Element | null, index: number): void {
      if (index === 0) firstOutcomeRef.value = el as HTMLElement | null;
    }
    // Focus after a committed Close. The Closed button is disabled by `write`
    // and the queue unmounts the row on success, so the head is the one
    // control still there.
    const headRef = ref<HTMLElement | null>(null);
    // Reset on every open; `submitClose` is the only path that commits.
    let closeKind: DialogClose = "dismissed";
    // Generated, never derived from the key: `aria-labelledby` is a
    // space-separated IDREF list, and the listing id in a key is a board's
    // free text.
    const dialogTitleId = useId();
    let trigger: HTMLElement | null = null;
    let untrap: (() => void) | null = null;

    watch(closing, async (isOpen) => {
      if (isOpen) {
        trigger = document.activeElement as HTMLElement | null;
        await nextTick();
        if (panelRef.value) untrap = trapFocus(panelRef.value, cancelClose);
      } else {
        untrap?.();
        untrap = null;
        focusAfterClose(closeKind, trigger, headRef.value)?.focus();
        trigger = null;
      }
    });
    onBeforeUnmount(() => untrap?.());

    const href = computed(() => postingHref(props.posting.url));
    const evidence = computed(() => evidenceLines(props.posting.evidence));
    const comp = computed(() => compLabel(props.posting));
    const score = computed(() =>
      props.compFloor === null
        ? null
        : scoreOf(props.posting, props.compFloor, Date.now(), props.productWords),
    );
    const age = computed(() => {
      // From the decision where there is one, from first_seen where not.
      const since = props.posting.status_at ?? props.posting.first_seen;
      if (since === null) return null;
      const days = daysBetween(since, Date.now());
      return Number.isNaN(days) ? null : ageLabel(days);
    });
    const tag = computed(() => statusTag(props.posting.status));
    const ageTitle = computed(() =>
      props.posting.status_at === null ? "Days since first seen" : "Days since this status was set",
    );
    // From `posted_at` only: `first_seen` is when the search noticed the
    // posting, not when the board put it up.
    const postedAge = computed(() => {
      const postedAt = props.posting.posted_at;
      if (postedAt === null) return null;
      const days = daysBetween(postedAt, Date.now());
      return Number.isNaN(days) ? null : postedAgeLabel(days);
    });
    // A reveal never resets itself for the rest of this card's life.
    const outcomes = computed(() =>
      revealedHere.value || props.revealed ? STATUSES : outcomesFor(props.posting.status),
    );
    // Activating "Change" unmounts the very button just clicked, so focus
    // would land on `<body>` and the next Tab restart at the top of the
    // document (WCAG 2.4.3). Only this path moves focus: a card that mounts
    // revealed because the view's set says so has no click behind it.
    async function reveal(): Promise<void> {
      revealedHere.value = true;
      emit("revealed", props.posting.key);
      await nextTick();
      firstOutcomeRef.value?.focus();
    }

    const writeError = ref<string | null>(null);

    async function write(status: Status, note: string | null): Promise<void> {
      busy.value = true;
      writeError.value = null;
      const patch = patchFor(props.posting, status, note, new Date().toISOString());
      const result = await setStatus(props.config, props.accessToken, props.posting.key, patch);
      busy.value = false;
      writeError.value = result.ok ? null : result.reason;
      if (result.ok) emit("decided", decidedOutcome(props.posting, patch));
    }

    function onOutcome(status: Status): void {
      if (status === "closed") {
        closeKind = "dismissed";
        closing.value = true;
        closeError.value = null;
        closeReason.value = "";
        return;
      }
      void write(status, props.posting.note);
    }

    function submitClose(): void {
      // A form submits on Enter in its own fields as well as on the disabled
      // button, so a second Enter mid-flight would PATCH twice.
      if (busy.value) return;
      const refusal = closeRefusal(closeReason.value);
      if (refusal !== null) {
        closeError.value = refusal;
        return;
      }
      closeKind = "committed";
      closing.value = false;
      void write("closed", closeReason.value.trim());
    }

    function cancelClose(): void {
      closing.value = false;
      closeReason.value = "";
      closeError.value = null;
    }

    // In a master-detail split the pane is the detail surface, so the row
    // stays shut and the click is a selection alone.
    function activate(): void {
      if (props.expandable) expanded.value = !expanded.value;
      emit("activated", props.posting.key);
    }

    // A window widened past the breakpoint would otherwise show the evidence twice.
    watch(
      () => props.expandable,
      (canExpand) => {
        if (!canExpand) expanded.value = false;
      },
    );

    return {
      expanded,
      busy,
      closing,
      closeReason,
      closeError,
      writeError,
      panelRef,
      headRef,
      dialogTitleId,
      href,
      evidence,
      comp,
      score,
      age,
      ageTitle,
      tag,
      postedAge,
      outcomes,
      setFirstOutcomeRef,
      reveal,
      onOutcome,
      submitClose,
      cancelClose,
      activate,
      labelOf,
      iconOf,
      toneOf,
      changeIcon: CHANGE_ICON,
    };
  },
  template: `
    <article class="card" :data-key="posting.key" :class="{ open: expanded, selected: selected }" :aria-current="selected ? 'true' : undefined">
      <div class="row">
        <button
          type="button"
          class="head"
          ref="headRef"
          :aria-expanded="expandable ? expanded : undefined"
          @click="activate">
          <span class="company">{{ posting.company }}</span>
          <span class="role" v-if="posting.title">{{ posting.title }}</span>
          <span class="role key" v-else>{{ posting.key }}</span>
          <span class="comp">{{ comp }}</span>
          <span class="meta">
            <span :class="['status', 'tag', 'tone-' + tag.tone]">{{ tag.label }}</span>
            <span class="age" :title="ageTitle" v-if="age">{{ age }}</span>
            <span class="age posted-age" title="How long ago the board posted this" v-if="postedAge">{{ postedAge }}</span>
          </span>
          <span class="score" v-if="score !== null" title="Pay against the floor, freshness, and whether the title names product work — out of 100">{{ score }}</span>
        </button>
        <span class="acts">
          <a
            v-if="href"
            class="icon-btn"
            :href="href"
            target="_blank"
            rel="noreferrer"
            title="Open the posting"
            :aria-label="'Open the posting for ' + posting.company">&#8599;</a>
          <template v-if="actionable">
            <template v-if="outcomes.length > 0">
              <button
                v-for="(status, index) in outcomes"
                :key="status"
                type="button"
                class="act"
                :class="{ close: status === 'closed' }"
                :disabled="busy"
                :ref="(el) => setFirstOutcomeRef(el, index)"
                :aria-label="labelOf(status) + ' — ' + posting.company"
                :title="labelOf(status)"
                @click="onOutcome(status)"><svg class="glyph" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="iconOf(status)" /></svg></button>
            </template>
            <button
              v-else
              type="button"
              class="ghost change"
              :aria-label="'Change — ' + posting.company"
              title="Change"
              @click="reveal"><svg class="glyph" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path :d="changeIcon" /></svg></button>
          </template>
        </span>
      </div>
      <p class="error" role="alert" v-if="writeError">{{ writeError }}</p>
      <div class="detail" v-if="expanded">
        <div class="note" v-if="posting.status === 'closed' && posting.note">
          <p class="note-label">Closed because</p>
          <p class="note-body">{{ posting.note }}</p>
        </div>
        <dl class="evidence" v-if="evidence.length > 0">
          <template v-for="line in evidence" :key="line.fact">
            <dt>{{ line.fact }}</dt>
            <dd>{{ line.detail }}</dd>
          </template>
        </dl>
        <p class="unsafe" v-if="posting.url && !href">The posting URL is not a web address: {{ posting.url }}</p>
      </div>
      <div class="scrim" v-if="closing" @click.self="cancelClose">
        <div
          class="decide close-prompt"
          role="dialog"
          aria-modal="true"
          tabindex="-1"
          :aria-labelledby="dialogTitleId"
          ref="panelRef">
          <h2 :id="dialogTitleId">Close — {{ posting.company }}</h2>
          <form @submit.prevent="submitClose">
            <p class="error" v-if="closeError">{{ closeError }}</p>
            <label>
              <span>Why does this disagree with the processor?</span>
              <textarea v-model="closeReason" rows="3"></textarea>
            </label>
            <div class="actions">
              <button type="button" class="ghost" @click="cancelClose">Cancel</button>
              <button type="submit" class="primary" :disabled="busy">Close</button>
            </div>
          </form>
        </div>
      </div>
    </article>
  `,
});
