/**
 * A live Vue renderer for the tests, rendering into plain objects instead
 * of a DOM: `renderToString` never mounts anything, and this project has no
 * DOM in test. An element is `{tag, props, children}`, `props` holds what
 * the component bound to it, and calling `props.onClick()` runs the real
 * handler and the reactive update that follows. It has no layout, no CSS,
 * no event bubbling and no notion of a disabled button ignoring a click.
 */
import { createRenderer, h, nextTick, type Component, type RendererOptions } from "vue";

export interface TreeNode {
  readonly tag: string;
  text: string;
  /** Vue's `vModelText` writes it on mount and reads it back on input; `fill` is the pair of those halves. */
  value: string;
  props: Record<string, unknown>;
  children: TreeNode[];
  parent: TreeNode | null;
  /** Handlers registered with `addEventListener` rather than as props. */
  readonly listeners: Map<string, Set<(event: object) => void>>;
  addEventListener(type: string, handler: (event: object) => void): void;
  removeEventListener(type: string, handler: (event: object) => void): void;
  /** Whether `.focus()` has been called on this node, the one thing about focus this fake DOM tracks; there is no active element. */
  focused: boolean;
  focus(): void;
  /** `TransitionGroup`'s leave hook adds and removes its own class names; nothing here reads them back, so `contains` always answers `false`. */
  readonly classList: {
    add(name: string): void;
    remove(name: string): void;
    contains(name: string): boolean;
  };
  /** `forceReflow` and `whenTransitionEnds` read style properties off a real `CSSStyleDeclaration`; an empty record answers every property with `undefined`. */
  readonly style: Record<string, string | undefined>;
  /** `forceReflow` reads `el.ownerDocument`, not the global, before it falls back; a getter keeps it pointed at whatever `stubDom` currently has installed. */
  readonly ownerDocument: unknown;
  /** `TransitionGroup`'s move animation clones a row into a container and back out. Always `1`, so that container is the row's own `TransitionGroup` root rather than `parentNode`, which this tree tracks under a different name. */
  readonly nodeType: number;
  /** The clone `hasCSSTransform` measures and immediately discards; a fresh node is enough; nothing reads its children or parent. */
  cloneNode(): TreeNode;
  /** The same check's container operations on that clone; both no-ops, since the clone is thrown away before anything else looks at the tree. */
  appendChild(child: TreeNode): void;
  removeChild(child: TreeNode): void;
  /** One class selector and nothing else; anything more returns nothing, so a focus trap installed on a node finds nothing to move. */
  querySelectorAll(selector?: string): TreeNode[];
  querySelector(selector: string): TreeNode | null;
  /** Backed by the `data-*` props Vue set. */
  readonly dataset: Record<string, string | undefined>;
}

/*
 * The four DOM methods above exist because `v-model` on the Close dialog's
 * textarea and `trapFocus` on its panel call them directly; without them
 * the dialog subtree throws on mount.
 */
function classSelector(selector: string | undefined): string | null {
  if (selector === undefined) return null;
  return /^\.[A-Za-z0-9_-]+$/.test(selector) ? selector.slice(1) : null;
}

function node(tag: string, text = ""): TreeNode {
  const listeners = new Map<string, Set<(event: object) => void>>();
  const self: TreeNode = {
    tag,
    text,
    value: "",
    props: {},
    children: [],
    parent: null,
    listeners,
    focused: false,
    // `data-key` is how `queue.ts` finds a row again after a re-render.
    dataset: new Proxy(
      {},
      {
        get: (_target, name) => (typeof name === "string" ? self.props[`data-${name}`] : undefined),
      },
    ) as Record<string, string | undefined>,
    addEventListener(type, handler) {
      const forType = listeners.get(type) ?? new Set();
      forType.add(handler);
      listeners.set(type, forType);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    focus() {
      this.focused = true;
    },
    classList: {
      add: () => {},
      remove: () => {},
      contains: () => false,
    },
    style: {},
    get ownerDocument() {
      return (globalThis as { document?: unknown }).document;
    },
    nodeType: 1,
    cloneNode: () => node(tag, text),
    appendChild: () => {},
    removeChild: () => {},
    querySelectorAll: (selector?: string) => {
      const className = classSelector(selector);
      if (className === null) return [];
      // Descendants only: a card asked for its own `.head` must not get back
      // the card.
      return elementsWithClass(self, className).filter((each) => each !== self);
    },
    querySelector: (selector: string) => self.querySelectorAll(selector)[0] ?? null,
  };
  return self;
}

const nodeOps: RendererOptions<TreeNode, TreeNode> = {
  createElement: (tag) => node(tag),
  createText: (text) => node("#text", text),
  createComment: (text) => node("#comment", text),
  setText: (target, text) => {
    target.text = text;
  },
  setElementText: (target, text) => {
    for (const child of target.children) child.parent = null;
    target.children = text === "" ? [] : [node("#text", text)];
  },
  insert: (child, parent, anchor) => {
    // Detached first: Vue moves a node by inserting it again, and a real
    // `insertBefore` takes it out of where it was. Without this a row the
    // grouped queue re-orders is in the list twice.
    const held = child.parent;
    if (held !== null) {
      const was = held.children.indexOf(child);
      if (was !== -1) held.children.splice(was, 1);
    }
    const at = anchor ? parent.children.indexOf(anchor) : -1;
    if (at === -1) parent.children.push(child);
    else parent.children.splice(at, 0, child);
    child.parent = parent;
  },
  remove: (child) => {
    const parent = child.parent;
    if (parent === null) return;
    const at = parent.children.indexOf(child);
    if (at !== -1) parent.children.splice(at, 1);
    child.parent = null;
  },
  parentNode: (target) => target.parent,
  nextSibling: (target) => {
    const parent = target.parent;
    if (parent === null) return null;
    return parent.children[parent.children.indexOf(target) + 1] ?? null;
  },
  patchProp: (element, key, _prev, next) => {
    element.props[key] = next;
  },
};

const { render } = createRenderer<TreeNode, TreeNode>(nodeOps);

export interface Mounted {
  readonly root: TreeNode;
  /** Runs every unmount hook, as a `v-if` or a changed `:key` does. */
  unmount(): void;
}

export function mountTree(component: Component, props: Record<string, unknown>): Mounted {
  const root = node("#root");
  render(h(component, props), root);
  return {
    root,
    unmount: () => render(null, root),
  };
}

export function allNodes(from: TreeNode): TreeNode[] {
  return [from, ...from.children.flatMap(allNodes)];
}

export function hasClass(target: TreeNode, className: string): boolean {
  const classes = target.props["class"];
  return typeof classes === "string" && classes.split(" ").includes(className);
}

export function elementsWithClass(from: TreeNode, className: string): TreeNode[] {
  return allNodes(from).filter((target) => hasClass(target, className));
}

export function textOf(from: TreeNode): string {
  return allNodes(from)
    .map((target) => target.text)
    .join("");
}

export function click(target: TreeNode): void {
  const handler = target.props["onClick"];
  if (typeof handler !== "function") throw new Error(`no click handler on <${target.tag}>`);
  (handler as () => void)();
}

/** The event is the one thing the handler touches: `@submit` carries `.prevent` on every form. */
export function submitForm(target: TreeNode): void {
  const handler = target.props["onSubmit"];
  if (typeof handler !== "function") throw new Error(`no submit handler on <${target.tag}>`);
  (handler as (event: object) => void)({ preventDefault: () => {} });
}

/** Sets the element's own value, then tells the directive's listener to read it, in a browser's order. */
export function fill(target: TreeNode, text: string): void {
  target.value = text;
  const listeners = target.listeners.get("input");
  if (listeners === undefined) throw new Error(`<${target.tag}> is not bound to a model`);
  for (const listener of listeners) listener({ target });
}

/**
 * For a field bound `:value` + `@input`, through the `onInput` prop Vue
 * compiled the `@input` into; `fill` reaches `v-model`'s listener via
 * `addEventListener`. A test using the wrong one gets "is not bound to a
 * model" rather than a silent pass.
 */
export function typeInto(target: TreeNode, text: string): void {
  const handler = target.props["onInput"];
  if (typeof handler !== "function") {
    throw new Error(`<${target.tag}> has no @input handler`);
  }
  (handler as (event: object) => void)({ target: { value: text } });
}

/**
 * The globals a mounted view reaches for. `document`, whose `activeElement`
 * an opening dialog reads (always null here), whose `body.offsetHeight` a
 * leaving row's transition reads to force a reflow (the number is never
 * used, only asked for), and whose `documentElement` is what
 * `usePaneMode` asks `getComputedStyle` about. `Element`, which
 * `TransitionGroup` tests each child against before measuring it, so
 * `Element` undefined makes the question itself throw. `requestAnimationFrame`,
 * which the leave hook waits two frames on before it lets a row go, run
 * synchronously here so a decided row is gone by the next microtask rather
 * than the next real frame. `getComputedStyle`, bare and as `window`'s
 * property (`usePaneMode` calls it bare; `TransitionGroup` calls it on
 * `window`), answering no property for anything asked of it, so a leaving
 * row reads "no transition declared" and `usePaneMode` reads
 * `--pane-mode` as unset. `window` itself, whose presence is what turns
 * `usePaneMode` from its SSR fallback (`typeof window === "undefined"`,
 * always false) into this stub, which answers false the same way; and
 * whose `addEventListener`/`removeEventListener` that mode's resize
 * listener registers and later tears down.
 */
export function stubDom(): () => void {
  const globals = globalThis as {
    document?: unknown;
    Element?: unknown;
    window?: unknown;
    requestAnimationFrame?: unknown;
    getComputedStyle?: unknown;
  };
  const had = {
    document: "document" in globals,
    Element: "Element" in globals,
    window: "window" in globals,
    requestAnimationFrame: "requestAnimationFrame" in globals,
    getComputedStyle: "getComputedStyle" in globals,
  };
  const original = {
    document: globals.document,
    Element: globals.Element,
    window: globals.window,
    requestAnimationFrame: globals.requestAnimationFrame,
    getComputedStyle: globals.getComputedStyle,
  };
  const computedStyle = () => ({ getPropertyValue: () => "" });
  globals.document = {
    activeElement: null,
    body: { offsetHeight: 0 },
    documentElement: {},
  };
  globals.Element = class {};
  globals.getComputedStyle = computedStyle;
  globals.window = {
    getComputedStyle: computedStyle,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globals.requestAnimationFrame = (callback: () => void) => {
    callback();
    return 0;
  };
  return () => {
    if (had.document) globals.document = original.document;
    else delete globals.document;
    if (had.Element) globals.Element = original.Element;
    else delete globals.Element;
    if (had.window) globals.window = original.window;
    else delete globals.window;
    if (had.requestAnimationFrame) globals.requestAnimationFrame = original.requestAnimationFrame;
    else delete globals.requestAnimationFrame;
    if (had.getComputedStyle) globals.getComputedStyle = original.getComputedStyle;
    else delete globals.getComputedStyle;
  };
}

/** The request's options reach the handler too, so a test can read the body a PATCH sent. */
export function stubFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

export function patchBody(init: RequestInit | undefined): Record<string, unknown> {
  const body = init?.body;
  if (typeof body !== "string") throw new Error("the request carried no JSON body");
  return JSON.parse(body) as Record<string, unknown>;
}

/** `patchOne` reads `ok` then the row array. */
export function patchedOne(): Response {
  return { ok: true, status: 200, json: async () => [{}] } as unknown as Response;
}

/** A write's continuation, then the re-render it causes. */
export async function settled(): Promise<void> {
  await new Promise((resume) => setTimeout(resume, 0));
  await nextTick();
}
