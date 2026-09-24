/**
 * What a master-detail view (Queue, Record) needs for the pane: which
 * posting is selected, the pane mode flag, the Up/Down row scan, advancing
 * the selection off a decided posting, and which end-status postings James
 * has asked to change. Shaped after `useToast()`: called once in `setup()`.
 */
import { computed, type ComputedRef, ref, type Ref } from "vue";

import type { PostingSummary } from "../../src/schema.ts";
import { nextFocusable } from "./focus-trap.ts";
import { nextSelection, resolveSelection, usePaneMode } from "./posting.ts";

export interface MasterDetailHandle {
  readonly selectedKey: Ref<string | null>;
  readonly selected: ComputedRef<PostingSummary | null>;
  readonly paneMode: Ref<boolean>;
  onListKeydown(event: KeyboardEvent): void;
  advanceSelection(decidedKey: string): void;
  onRevealed(key: string): void;
  isRevealed(key: string): boolean;
}

/** `postings` is the caller's ordered, filtered list, read live through the computed, never copied in. */
export function useMasterDetail(
  postings: ComputedRef<readonly PostingSummary[]>,
): MasterDetailHandle {
  const selectedKey = ref<string | null>(null);
  const paneMode = usePaneMode();
  const selected = computed(() => resolveSelection(postings.value, selectedKey.value));

  // Deciding the pane's own posting moves the pane on to the next one; a
  // decision on some other row leaves the selection where it is.
  function advanceSelection(decidedKey: string): void {
    if (selected.value !== null && selected.value.key === decidedKey) {
      selectedKey.value = nextSelection(postings.value, decidedKey);
    }
  }

  // Up/Down steps between rows' head buttons the way a list box would.
  // Scoped to `.head` targets so it never intercepts a row's other
  // controls, and to Up/Down alone so a Close dialog's `trapFocus` (bound
  // on `.decide`, which bubbles through this listener) keeps its Escape/Tab
  // handling.
  function onListKeydown(event: KeyboardEvent): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.classList.contains("head")) return;
    const container = event.currentTarget as HTMLElement;
    const heads = Array.from(container.querySelectorAll<HTMLElement>(".card .head"));
    // A list scan stops at either end; wrapping would jump ArrowDown on the
    // last row back to the first, scrolling the page with it.
    const next = nextFocusable(heads, target, event.key === "ArrowUp", false);
    if (next === null) return;
    event.preventDefault();
    next.focus();
  }

  // Held by the view rather than the card because a Record filter that
  // stops matching a revealed row unmounts it and mounts a fresh one when
  // the filter widens. A key is never removed: a reveal is the operator's to keep
  // for the life of the page.
  const revealed = ref<ReadonlySet<string>>(new Set());
  function onRevealed(key: string): void {
    revealed.value = new Set(revealed.value).add(key);
  }
  const isRevealed = (key: string): boolean => revealed.value.has(key);

  return {
    selectedKey,
    selected,
    paneMode,
    onListKeydown,
    advanceSelection,
    onRevealed,
    isRevealed,
  };
}
