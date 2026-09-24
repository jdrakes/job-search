/**
 * Focus handling for the hand-rolled `.scrim`/`.decide` dialogs: no native
 * `<dialog>`, so opening one must move focus in, Tab must not escape it,
 * Escape must, and closing must return focus (WCAG 2.4.3, 2.1.2).
 */
export interface Focusable {
  focus(): void;
}

/**
 * `wrap` cycles at either end, right for the Tab trap; the row scan in
 * `master-detail.ts` passes `false` so the last row is a stop, not a jump
 * back across the list.
 */
export function nextFocusable<T extends Focusable>(
  elements: readonly T[],
  active: T | null,
  backward: boolean,
  wrap: boolean = true,
): T | null {
  if (elements.length === 0) return null;
  const at = active === null ? -1 : elements.indexOf(active);
  if (at === -1) return elements[backward ? elements.length - 1 : 0] ?? null;
  const step = backward ? -1 : 1;
  if (!wrap && (at + step < 0 || at + step >= elements.length)) return null;
  const next = (at + step + elements.length) % elements.length;
  return elements[next] ?? null;
}

export type DialogClose = "dismissed" | "committed";

/**
 * A dismissed dialog returns focus to the button that opened it. A
 * committed one must not: the write first disables that button and then
 * unmounts it (a decided queue row is removed; a dropped company's card
 * loses its `.acts` block), so focus would fall to `<body>` and the next
 * Tab restart at the top of the page. `anchor` is what the commit leaves
 * standing.
 */
export function focusAfterClose<T extends Focusable>(
  close: DialogClose,
  trigger: T | null,
  anchor: T | null,
): T | null {
  return close === "committed" ? anchor : (trigger ?? anchor);
}

export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Returns the teardown for close. */
export function trapFocus(panel: HTMLElement, onEscape: () => void): () => void {
  const focusables = (): HTMLElement[] =>
    Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  (focusables()[0] ?? panel).focus();
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") return onEscape();
    if (event.key !== "Tab") return;
    const next = nextFocusable(
      focusables(),
      document.activeElement as HTMLElement | null,
      event.shiftKey,
    );
    if (next !== null) {
      event.preventDefault();
      next.focus();
    }
  }
  panel.addEventListener("keydown", onKeydown);
  return () => panel.removeEventListener("keydown", onKeydown);
}
