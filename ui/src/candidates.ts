/**
 * Every candidate, newest first, with an Add form at the top for one James
 * found himself. `addCandidate` (`api.ts`) always writes `origin: "james"`;
 * discover adds the rest as `peers` and settles every one's outcome at the
 * next run. The write hands back no row (`WriteResult` carries no value), so
 * a committed add is echoed here from the form's own input rather than read
 * back, the way a dropped company is a patch handed up rather than a
 * re-read row (`companies.ts`).
 */
import { defineComponent, ref, type PropType } from "vue";

import type { Candidate, Outcome } from "../../src/schema.ts";
import { addCandidate, type CandidateInput } from "./api.ts";
import type { AppConfig } from "./config.ts";
import { EmptyState } from "./empty-state.ts";
import { Toast, useToast } from "./toast.ts";

// Every outcome but `alias`, which also names the company it is another
// name for and so needs the row's own data, not a fixed word.
const OUTCOME_WORDS: Record<Exclude<Outcome, "alias">, string> = {
  watched: "watched",
  added: "board added",
  known: "already known",
  no_board: "no board found",
  wrong_company: "board names another company",
  gone: "board gone",
  dropped: "dropped",
  bad_url: "URL names no board",
};

/** What discover made of a candidate, worded for the row rather than the enum it wrote. */
export function outcomeText(candidate: Candidate): string {
  if (candidate.outcome === null) return "waiting for the next run";
  if (candidate.outcome === "alias") return `another name for ${candidate.company ?? "a company"}`;
  return OUTCOME_WORDS[candidate.outcome];
}

/** The name if there is one, else the URL. Never both blank: `addCandidate` refuses that before it sends anything. */
export function candidateLabel(candidate: Candidate): string {
  return candidate.name ?? candidate.url ?? "";
}

/** `null` for a field left blank, whitespace included: an empty string reaching the store would be a fact, not an absence. */
function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export const CandidatesView = defineComponent({
  name: "CandidatesView",
  components: { EmptyState, Toast },
  props: {
    candidates: { type: Array as PropType<Candidate[]>, required: true },
    config: { type: Object as PropType<AppConfig>, required: true },
    accessToken: { type: String, required: true },
  },
  emits: {
    // Handed up to `AppRoot`, which lays it over the round the way a
    // dropped company is; this view keeps no copy of its own, so switching
    // tabs away and back (a `v-if`) does not lose it.
    added: (_candidate: Candidate) => true,
  },
  setup(props, { emit }) {
    const name = ref("");
    const url = ref("");
    const why = ref("");
    const busy = ref(false);
    const error = ref<string | null>(null);
    const { toast, showToast } = useToast();
    // Bumped on a committed add and bound as the form's `:key`, so Vue tears
    // the three fields down and remounts them fresh rather than patching a
    // value into an input still holding what James typed. Patching a v-model
    // input whose bound value changes out from under it needs `getRootNode`
    // on the element (`vModelText.beforeUpdate`, `@vue/runtime-dom`), which
    // this project's browsers have and its no-DOM test renderer does not.
    const formKey = ref(0);

    async function submit(): Promise<void> {
      const input: CandidateInput = {
        name: blankToNull(name.value),
        url: blankToNull(url.value),
        evidence: blankToNull(why.value),
      };
      error.value = null;
      busy.value = true;
      const result = await addCandidate(props.config, props.accessToken, input);
      busy.value = false;
      if (!result.ok) {
        error.value = result.reason;
        return;
      }
      emit("added", {
        id: crypto.randomUUID(),
        name: input.name,
        url: input.url,
        origin: "james",
        evidence: input.evidence,
        added_at: new Date().toISOString(),
        outcome: null,
        outcome_at: null,
        company: null,
      });
      name.value = "";
      url.value = "";
      why.value = "";
      formKey.value += 1;
      showToast("Added.");
    }

    return { name, url, why, busy, error, toast, formKey, submit, candidateLabel, outcomeText };
  },
  template: `
    <section
      class="candidates"
      role="tabpanel"
      id="panel-candidates"
      aria-labelledby="tab-candidates"
      tabindex="-1">
      <form :key="formKey" @submit.prevent="submit">
        <p class="error" v-if="error">{{ error }}</p>
        <p class="hint">One of name or URL is enough; discover settles the rest at the next run.</p>
        <label>
          <span>Name</span>
          <input type="text" v-model="name" />
        </label>
        <label>
          <span>URL</span>
          <input type="text" v-model="url" />
        </label>
        <label>
          <span>Why</span>
          <textarea v-model="why" rows="2"></textarea>
        </label>
        <div class="actions">
          <button type="submit" class="primary" :disabled="busy">{{ busy ? 'Adding…' : 'Add' }}</button>
        </div>
      </form>
      <Toast :toast="toast" />
      <EmptyState v-if="candidates.length === 0" text="No candidates yet." />
      <div class="list" v-else>
        <article class="card candidate" v-for="candidate in candidates" :key="candidate.id">
          <div class="row">
            <div class="head">
              <span class="candidate-name">{{ candidateLabel(candidate) }}</span>
              <span class="meta">
                <span class="origin">{{ candidate.origin }}</span>
                <span class="outcome">{{ outcomeText(candidate) }}</span>
                <span class="company" v-if="candidate.company">{{ candidate.company }}</span>
              </span>
              <span class="why" v-if="candidate.evidence">{{ candidate.evidence }}</span>
            </div>
          </div>
        </article>
      </div>
    </section>
  `,
});
