import assert from "node:assert/strict";
import { test } from "node:test";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";

import { Toast } from "../src/toast.ts";

function render(component: object, props: Record<string, unknown>): Promise<string> {
  return renderToString(createSSRApp(component, props));
}

// The whole element: anything that would make it look operable (tabindex,
// an interactive role, a focus hook) has to fail here.
test("Toast renders the text as a plain status line with nothing to operate", async () => {
  const html = await render(Toast, { toast: { text: "Saved." } });
  assert.equal(html, `<p class="toast notice" role="status">Saved.</p>`);
});

test("Toast renders nothing when there is no toast", async () => {
  const html = await render(Toast, { toast: null });
  assert.equal(html.trim(), "<!---->");
});

test("Toast declares no events, so no view can wire a dismiss handler to it", () => {
  assert.equal(Toast.emits, undefined);
});
