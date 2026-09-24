/**
 * Every company, grouped by state. The one action is Drop, and it asks why
 * for the same reason Closing a posting does: disagreeing with the pipeline
 * without saying why teaches it nothing.
 */
import {
  computed,
  defineComponent,
  nextTick,
  onBeforeUnmount,
  ref,
  useId,
  watch,
  type PropType,
} from "vue";

import type { Company, CompanyState, PostingSummary } from "../../src/schema.ts";
import { setCompanyDrop, type CompanyDropPatch } from "./api.ts";
import type { AppConfig } from "./config.ts";
import { EmptyState } from "./empty-state.ts";
import { focusAfterClose, trapFocus, type DialogClose } from "./focus-trap.ts";
import { Toast, useToast } from "./toast.ts";

// A drop is the operator's flag, not a state, so the page's groups are one more
// than the states: a dropped company sits in Dropped whatever its state.
export type CompanyGroupKey = CompanyState | "dropped";

// Not `COMPANY_STATES`' declaration order: watched leads because it is
// where the work is.
const GROUP_ORDER: readonly CompanyGroupKey[] = ["watched", "discovered", "dropped", "alias"];

const GROUP_LABELS: Record<CompanyGroupKey, string> = {
  watched: "Watched",
  discovered: "Discovered",
  dropped: "Dropped",
  alias: "Aliases",
};

export interface CompanyGroup {
  readonly key: CompanyGroupKey;
  readonly label: string;
  readonly companies: readonly Company[];
}

export function groupOf(company: Company): CompanyGroupKey {
  return company.dropped_at !== null ? "dropped" : company.state;
}

/** A company with none is absent. */
export function countsByCompany(queue: readonly PostingSummary[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const posting of queue) {
    counts.set(posting.company, (counts.get(posting.company) ?? 0) + 1);
  }
  return counts;
}

/** Bucketed by `groupOf`, each group by queued postings, most first, then name. */
export function groupByState(
  companies: readonly Company[],
  counts: ReadonlyMap<string, number>,
): CompanyGroup[] {
  const queued = (company: Company): number => counts.get(company.name) ?? 0;
  return GROUP_ORDER.map((key) => ({
    key,
    label: GROUP_LABELS[key],
    companies: companies
      .filter((company) => groupOf(company) === key)
      .sort((a, b) => queued(b) - queued(a) || a.name.localeCompare(b.name)),
  }));
}

export function queuedLabel(count: number): string {
  if (count === 0) return "none in queue";
  return count === 1 ? "1 in queue" : `${count} in queue`;
}

export function boardLabel(company: Company): string {
  return company.boards.map((board) => `${board.platform}:${board.id}`).join(", ");
}

/** the operator's reason if he gave one; otherwise the owner an alias points at; otherwise nothing. */
export function whyText(company: Company): string | null {
  if (company.reason) return company.reason;
  if (company.alias_of) return `alias of ${company.alias_of}`;
  return null;
}

export function dropRefusal(reason: string): string | null {
  return reason.trim() === "" ? "Say why — dropping a company is a judgement, not a fact." : null;
}

/**
 * What a committed Drop hands up. `AppRoot` lays the patch over the round it
 * holds, the way it does a posting's status, so the drop outlives this view:
 * the Companies panel is a `v-if`, and a map kept here dies with it.
 */
export interface DroppedCompany {
  readonly name: string;
  readonly patch: CompanyDropPatch;
}

export const CompaniesView = defineComponent({
  name: "CompaniesView",
  components: { EmptyState, Toast },
  props: {
    companies: { type: Array as PropType<Company[]>, required: true },
    queue: { type: Array as PropType<PostingSummary[]>, required: true },
    config: { type: Object as PropType<AppConfig>, required: true },
    accessToken: { type: String, required: true },
    // Seeds the drop dialog open, for an SSR test with no DOM to click.
    initialDropping: { type: String as PropType<string | null>, default: null },
  },
  emits: {
    dropped: (_company: DroppedCompany) => true,
  },
  setup(props, { emit }) {
    const busy = ref(false);
    const { toast, showToast } = useToast();
    const dropping = ref<Company | null>(
      props.initialDropping === null
        ? null
        : (props.companies.find((company) => company.name === props.initialDropping) ?? null),
    );
    const dropReason = ref("");
    const dropError = ref<string | null>(null);
    const panelRef = ref<HTMLElement | null>(null);
    // Focus after a committed Drop. The Drop button is disabled during the
    // write and then unmounts (the card moves to the dropped group, where
    // `.acts` does not render), and the dropped card's head is a `<div>`, so
    // the panel itself is the nearest thing that survives every drop. Its tab
    // names it, so focus landing there says "Companies".
    const sectionRef = ref<HTMLElement | null>(null);
    // Reset on every open; `submitDrop` is the only path that commits.
    let closeKind: DialogClose = "dismissed";
    // Generated, never derived from the name: `aria-labelledby` is a
    // space-separated IDREF list, and "Overland Transport & Logistics"
    // produced an id no browser could resolve.
    const dialogTitleId = useId();
    let trigger: HTMLElement | null = null;
    let untrap: (() => void) | null = null;

    watch(dropping, async (company) => {
      if (company !== null) {
        trigger = document.activeElement as HTMLElement | null;
        await nextTick();
        if (panelRef.value) untrap = trapFocus(panelRef.value, cancelDrop);
      } else {
        untrap?.();
        untrap = null;
        focusAfterClose(closeKind, trigger, sectionRef.value)?.focus();
        trigger = null;
      }
    });
    onBeforeUnmount(() => untrap?.());

    const counts = computed(() => countsByCompany(props.queue));
    const groups = computed(() => groupByState(props.companies, counts.value));
    const queuedOf = (company: Company): string => queuedLabel(counts.value.get(company.name) ?? 0);

    function openDrop(company: Company): void {
      closeKind = "dismissed";
      dropping.value = company;
      dropReason.value = "";
      dropError.value = null;
    }

    function cancelDrop(): void {
      dropping.value = null;
      dropReason.value = "";
      dropError.value = null;
    }

    async function submitDrop(): Promise<void> {
      const refusal = dropRefusal(dropReason.value);
      if (refusal !== null) {
        dropError.value = refusal;
        return;
      }
      const company = dropping.value;
      if (company === null) return;
      busy.value = true;
      const patch: CompanyDropPatch = {
        dropped_at: new Date().toISOString(),
        reason: dropReason.value.trim(),
      };
      const result = await setCompanyDrop(props.config, props.accessToken, company.name, patch);
      busy.value = false;
      if (result.ok) {
        emit("dropped", { name: company.name, patch });
        closeKind = "committed";
        dropping.value = null;
        showToast(`Dropped ${company.name}.`);
      } else {
        dropError.value = result.reason;
      }
    }

    return {
      groups,
      counts,
      busy,
      dropping,
      dropReason,
      dropError,
      panelRef,
      sectionRef,
      dialogTitleId,
      boardLabel,
      whyText,
      queuedOf,
      groupOf,
      openDrop,
      cancelDrop,
      submitDrop,
      toast,
    };
  },
  template: `
    <section
      class="companies"
      role="tabpanel"
      id="panel-companies"
      aria-labelledby="tab-companies"
      tabindex="-1"
      ref="sectionRef">
      <div v-for="group in groups" :key="group.key">
        <h2 class="group-head">{{ group.label }} <span class="count">({{ group.companies.length }})</span></h2>
        <EmptyState v-if="group.companies.length === 0" text="None." />
        <TransitionGroup tag="div" name="list" class="list" :class="group.key" v-else>
          <article class="card company" v-for="company in group.companies" :key="company.name">
            <div class="row">
              <div class="head">
                <span class="company">{{ company.name }}</span>
                <span class="board" v-if="company.boards.length > 0">{{ boardLabel(company) }}</span>
                <span class="board none" v-else>no board yet</span>
                <span class="queued" :class="{ none: !counts.get(company.name) }">{{ queuedOf(company) }}</span>
                <span class="why" v-if="whyText(company)">{{ whyText(company) }}</span>
              </div>
              <span class="acts" v-if="groupOf(company) !== 'dropped' && groupOf(company) !== 'alias'">
                <button
                  type="button"
                  class="act close"
                  :disabled="busy"
                  title="Drop"
                  :aria-label="'Drop ' + company.name"
                  @click="openDrop(company)"><svg class="glyph" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM3.8 12.2l8.4-8.4" /></svg></button>
              </span>
            </div>
          </article>
        </TransitionGroup>
      </div>
      <Toast :toast="toast" />
      <div class="scrim" v-if="dropping" @click.self="cancelDrop">
        <div
          class="decide drop-prompt"
          role="dialog"
          aria-modal="true"
          tabindex="-1"
          :aria-labelledby="dialogTitleId"
          ref="panelRef">
          <h2 :id="dialogTitleId">Drop — {{ dropping.name }}</h2>
          <form @submit.prevent="submitDrop">
            <p class="error" v-if="dropError">{{ dropError }}</p>
            <label>
              <span>Why drop this company?</span>
              <textarea v-model="dropReason" rows="3"></textarea>
            </label>
            <div class="actions">
              <button type="button" class="ghost" @click="cancelDrop">Cancel</button>
              <button type="submit" class="primary" :disabled="busy">Drop</button>
            </div>
          </form>
        </div>
      </div>
    </section>
  `,
});
