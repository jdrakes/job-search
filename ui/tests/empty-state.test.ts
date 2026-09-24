import assert from "node:assert/strict";
import { test } from "node:test";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";

import { EmptyState } from "../src/empty-state.ts";

function render(component: object, props: Record<string, unknown>): Promise<string> {
  return renderToString(createSSRApp(component, props));
}

test("EmptyState renders the tray mark and the given text", async () => {
  const html = await render(EmptyState, { text: "Nothing waiting on you." });

  assert.match(html, /class="empty-mark"/);
  assert.match(html, /Nothing waiting on you\./);
});
