/** Mounting either master-detail view live, and finding the parts of a `PostingCard` in the tree it renders. */
import { defineComponent, h, ref, type Component } from "vue";

import type { PostingSummary } from "../../src/schema.ts";
import type { StatusPatch } from "../src/api.ts";
import type { DecidedOutcome } from "../src/posting.ts";
import {
  allNodes,
  elementsWithClass,
  mountTree,
  textOf,
  type Mounted,
  type TreeNode,
} from "./render-tree.ts";

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`no ${what} in the rendered tree`);
  return value;
}

export function cardIn(root: TreeNode, region: string, company: string): TreeNode {
  const area = must(elementsWithClass(root, region)[0], region);
  return must(
    elementsWithClass(area, "card").find((card) => textOf(card).includes(company)),
    `${company} card in the ${region}`,
  );
}

/** By the label it announces ("Applied — Acme"). */
export function outcomeButton(card: TreeNode, label: string): TreeNode {
  return must(
    elementsWithClass(card, "act").find((button) => button.props["aria-label"] === label),
    `${label} button`,
  );
}

export function isDisabled(card: TreeNode, label: string): unknown {
  return outcomeButton(card, label).props["disabled"];
}

export function changeButton(card: TreeNode): TreeNode {
  return must(elementsWithClass(card, "change")[0], "change button");
}

/** Its form, its reason field, its submit. */
export function partOfDialog(
  card: TreeNode,
  tag: string,
  props: Record<string, unknown> = {},
): TreeNode {
  return must(
    allNodes(card).find(
      (target) =>
        target.tag === tag &&
        Object.entries(props).every(([name, value]) => target.props[name] === value),
    ),
    `<${tag}> of the open dialog`,
  );
}

/**
 * `AppRoot` in miniature: it keeps what the view emits and hands the
 * postings back down wearing it. Neither view holds a decision of its own
 * now, so a test that watches a decided row change needs the other half of
 * the pair.
 *
 * What it does not model: the `history` prop `AppRoot` passes `QueueView`,
 * which carries the record read's acted-on postings. Both callers mount a
 * flat order, and the flat orders never read `history`, so nothing is wrong
 * today. A grouped test written on this stand-in would be: it would see a
 * decided row show up only through `QueueView`'s own dedupe of the queue
 * side, or not at all, and encode whichever it saw as correct. Mount the
 * real `AppRoot` (`ui/tests/app.test.ts`) for anything grouped.
 */
export function mountUnderAppRoot(
  view: Component,
  postings: readonly PostingSummary[],
  props: Record<string, unknown>,
): Mounted {
  const parent = defineComponent({
    name: "AppRootStandIn",
    setup() {
      const decided = ref<ReadonlyMap<string, StatusPatch>>(new Map());
      return () =>
        h(view, {
          ...props,
          postings: postings.map((posting) => {
            const patch = decided.value.get(posting.key);
            return patch ? { ...posting, ...patch } : posting;
          }),
          onDecided: (outcome: DecidedOutcome) => {
            decided.value = new Map(decided.value).set(outcome.key, outcome.patch);
          },
        });
    },
  });
  return mountTree(parent, {});
}
