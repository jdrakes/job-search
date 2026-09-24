/**
 * The sign-in form. A plain object component with a string template:
 * there is no bundler and so no `.vue` compiler; Vue's full browser build
 * carries the template compiler and `@vue/server-renderer` the SSR one.
 */
import { defineComponent, type PropType } from "vue";

export type SignInStage = "email" | "code";

export const SignIn = defineComponent({
  name: "SignIn",
  props: {
    stage: { type: String as PropType<SignInStage>, required: true },
    email: { type: String, required: true },
    code: { type: String, required: true },
    busy: { type: Boolean, required: true },
    // Optional with a null default: Vue's runtime check only skips a null
    // when the prop is not required.
    error: { type: String as PropType<string | null>, default: null },
  },
  emits: ["update:email", "update:code", "request", "verify"],
  // `autofocus` does not fire when the code input mounts after `stage`
  // flips, so that stage focuses itself here. Vue never runs watcher
  // callbacks during server rendering, so this stays clear of the DOM.
  watch: {
    stage: {
      // Post-flush: with the default "pre" timing the input the ref points at
      // does not exist yet and the `?.` guard silently no-ops.
      handler() {
        this.focusCodeInput();
      },
      flush: "post",
    },
  },
  methods: {
    focusCodeInput() {
      if (this.stage === "code") {
        (this.$refs["codeInput"] as HTMLInputElement | undefined)?.focus();
      }
    },
  },
  template: `
    <form class="sign-in" @submit.prevent="stage === 'email' ? $emit('request') : $emit('verify')">
      <h1>Job search</h1>
      <p class="lead" v-if="stage === 'email'">Sign in to see what needs you.</p>
      <p class="lead" v-else>Check {{ email }} for a one-time code.</p>

      <label v-if="stage === 'email'">
        <span>Email</span>
        <input
          type="email"
          name="email"
          autocomplete="email"
          autofocus
          required
          :value="email"
          @input="$emit('update:email', $event.target.value)" />
      </label>

      <label v-else>
        <span>One-time code</span>
        <input
          ref="codeInput"
          type="text"
          name="code"
          inputmode="numeric"
          autocomplete="one-time-code"
          required
          :value="code"
          @input="$emit('update:code', $event.target.value)" />
      </label>

      <button type="submit" class="primary" :disabled="busy">
        {{ stage === 'email' ? (busy ? 'Sending…' : 'Send me a code') : (busy ? 'Signing in…' : 'Sign in') }}
      </button>
      <p class="error" role="alert" v-if="error">{{ error }}</p>
    </form>
  `,
});
