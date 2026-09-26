/**
 * The sign-in form. A plain object component with a string template:
 * there is no bundler and so no `.vue` compiler; Vue's full browser build
 * carries the template compiler and `@vue/server-renderer` the SSR one.
 */
import { defineComponent, type PropType } from "vue";

export type SignInStage = "email" | "sent";

export const SignIn = defineComponent({
  name: "SignIn",
  props: {
    stage: { type: String as PropType<SignInStage>, required: true },
    email: { type: String, required: true },
    busy: { type: Boolean, required: true },
    // Optional with a null default: Vue's runtime check only skips a null
    // when the prop is not required.
    error: { type: String as PropType<string | null>, default: null },
  },
  emits: ["update:email", "request", "restart"],
  template: `
    <form class="sign-in" @submit.prevent="$emit('request')" v-if="stage === 'email'">
      <h1>Job search</h1>
      <p class="lead">Sign in to see what needs you.</p>

      <label>
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

      <button type="submit" class="primary" :disabled="busy">
        {{ busy ? 'Sending…' : 'Email me a sign-in link' }}
      </button>
      <p class="error" role="alert" v-if="error">{{ error }}</p>
    </form>
    <div class="sign-in" v-else>
      <h1>Job search</h1>
      <p class="lead">Check {{ email }} for a sign-in link.</p>
      <button type="button" class="ghost" @click="$emit('restart')">Use a different address</button>
      <p class="error" role="alert" v-if="error">{{ error }}</p>
    </div>
  `,
});
