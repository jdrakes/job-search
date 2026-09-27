/**
 * The mounted application: sign-in, then four tabs sharing one round of
 * reads. A read that fails leaves the other tabs with what they had.
 *
 * `AppRoot`'s `setup()` is async, which is why `mountApp` wraps it in
 * `<Suspense>`: Vue requires that in the browser, though `renderToString`
 * (the tests) awaits an async root with no wrapper. The clock, fetch and
 * the session store arrive as props so a test can fake each.
 */
import {
  computed,
  createApp,
  defineComponent,
  h,
  ref,
  Suspense,
  type PropType,
  type Ref,
} from "vue";

import type { Candidate, Company, Criteria, PostingSummary } from "../../src/schema.ts";
import {
  loadCandidates,
  loadCompanies,
  loadCriteria,
  loadPostings,
  loadQueue,
  type CompanyDropPatch,
  type ReadResult,
  type StatusPatch,
} from "./api.ts";
import {
  clearSession,
  ensureFreshSession,
  loadSession,
  linkTokenFrom,
  refreshSession,
  refreshStillApplies,
  requestLink,
  saveSession,
  SESSION_KEY,
  verifyLink,
  type AuthResult,
  type Session,
  type SessionStore,
} from "./auth.ts";
import { CandidatesView } from "./candidates.ts";
import { CompaniesView, type DroppedCompany } from "./companies.ts";
import { parseConfig, type AppConfig } from "./config.ts";
import { CriteriaView } from "./criteria.ts";
import type { DecidedOutcome } from "./posting.ts";
import { QueueView } from "./queue.ts";
import { clearReads, loadReads, saveReads } from "./reads-cache.ts";
import { RecordView } from "./record.ts";
import { SignIn, type SignInStage } from "./sign-in.ts";
import { TabBar, TABS, type TabId } from "./tabs.ts";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `ensureFreshSession`'s refresh call can throw; a failed sign-in must not crash the shell. */
async function currentSession(
  config: AppConfig,
  session: Session,
  httpFetch: typeof fetch,
  now: () => number,
): Promise<AuthResult<Session>> {
  try {
    return await ensureFreshSession(session, now(), (candidate) =>
      refreshSession(config, candidate, httpFetch, now()),
    );
  } catch (error) {
    return { ok: false, reason: messageOf(error) };
  }
}

/**
 * Lowers `flag` however the round ends: `saveSession` does not catch a
 * failed `localStorage.setItem` (quota, Safari private browsing), and a
 * lowering on the success path alone would leave the page saying
 * the queue's count replaced by a turning ring, with every Try again button
 * disabled until a reload.
 */
export async function runRefresh(flag: Ref<boolean>, round: () => Promise<void>): Promise<void> {
  flag.value = true;
  try {
    await round();
  } finally {
    flag.value = false;
  }
}

/**
 * A round's rows wearing what James has decided since it was read. Both
 * reads go through it: `loadPostings` returns every queue row too, so a
 * posting decided on this page must read the same in the Queue and the
 * Record.
 */
/**
 * The same idea for companies: the round's rows wearing the drops James has
 * committed since it was read. A separate four lines rather than one
 * function over both, because the two key off different fields and a shared
 * version would have to take a key accessor at all four call sites to serve
 * one of them.
 */
function droppedWith(
  companies: readonly Company[],
  dropped: ReadonlyMap<string, CompanyDropPatch>,
): Company[] {
  return companies.map((company) => {
    const patch = dropped.get(company.name);
    return patch ? { ...company, ...patch } : company;
  });
}

function patchedWith(
  postings: readonly PostingSummary[],
  decided: ReadonlyMap<string, StatusPatch>,
): PostingSummary[] {
  return postings.map((posting) => {
    const patch = decided.get(posting.key);
    return patch ? { ...posting, ...patch } : posting;
  });
}

export const AppRoot = defineComponent({
  name: "AppRoot",
  components: { SignIn, TabBar, QueueView, RecordView, CompaniesView, CandidatesView, CriteriaView },
  props: {
    config: { type: Object as PropType<AppConfig>, required: true },
    store: { type: Object as PropType<SessionStore>, required: true },
    httpFetch: { type: Function as PropType<typeof fetch>, required: true },
    now: { type: Function as PropType<() => number>, required: true },
    // Which tab a fresh mount opens on; a test seeds it to render a tab with
    // no click to reach it.
    initialTab: { type: String as PropType<TabId>, default: "queue" },
    // A callback, not `history` here: ui/src stays DOM-free, and `mountApp`
    // owns the window.
    rememberTab: { type: Function as PropType<(id: TabId) => void>, default: () => () => {} },
    // The `token_hash` a sign-in link brought back, and how to take it out
    // of the address bar; both come from `mountApp` for the same reason.
    linkToken: { type: String as PropType<string | null>, default: null },
    forgetLinkToken: { type: Function as PropType<() => void>, default: () => () => {} },
    // The email link always opens a second, new tab — the email app decides
    // that, not this page — so the tab left waiting on "Check your email"
    // has to notice the other tab's sign-in itself. `mountApp` calls
    // `onChange` on a `storage` event carrying the session, and again on
    // focus/visibility, since a backgrounded phone tab may miss the event
    // outright and only gets a chance to look again once it's back on screen.
    watchSession: {
      type: Function as PropType<(onChange: () => void) => void>,
      default: () => () => {},
    },
  },
  async setup(props) {
    const tab = ref<TabId>(props.initialTab);
    const session = ref<Session | null>(loadSession(props.store, props.now()));

    const signInStage = ref<SignInStage>("email");
    const email = ref("");
    const signInBusy = ref(false);
    const signInError = ref<string | null>(null);

    const queueResult = ref<ReadResult<PostingSummary[]> | null>(null);
    const postingsResult = ref<ReadResult<PostingSummary[]> | null>(null);
    const companiesResult = ref<ReadResult<Company[]> | null>(null);
    const criteriaResult = ref<ReadResult<Criteria> | null>(null);
    const candidatesResult = ref<ReadResult<Candidate[]> | null>(null);

    const refreshing = ref(false);

    // What James has decided on this page, laid over both reads until a
    // round comes back carrying it. It lives here rather than in the views
    // so a decision survives the tab switch that unmounts the one he made
    // it in, and so the Queue and the Record never disagree about a row.
    const decided = ref<ReadonlyMap<string, StatusPatch>>(new Map());
    function onDecided(outcome: DecidedOutcome): void {
      decided.value = new Map(decided.value).set(outcome.key, outcome.patch);
    }

    const dropped = ref<ReadonlyMap<string, CompanyDropPatch>>(new Map());
    function onDropped(company: DroppedCompany): void {
      dropped.value = new Map(dropped.value).set(company.name, company.patch);
    }

    // What James has added on this page, laid over the round's own
    // candidates until a round reads them back, the same way a drop is laid
    // over companies: the Candidates panel is a `v-if`, and a list kept
    // there dies with it. `addCandidate` hands back no row to key on (the
    // store assigns the id), so this holds the echo the form itself built.
    const added = ref<readonly Candidate[]>([]);
    function onCandidateAdded(candidate: Candidate): void {
      added.value = [candidate, ...added.value];
    }

    async function loadAll(readFor: Session): Promise<void> {
      // Taken before the reads are issued: a decision made while they are in
      // flight is not in their response, so dropping the whole map on
      // success would put the old status back on screen.
      const applied = new Set(decided.value.keys());
      const committed = new Set(dropped.value.keys());
      const submitted = new Set(added.value.map((candidate) => candidate.id));
      const accessToken = readFor.accessToken;
      const [queue, postings, companies, criteria, candidates] = await Promise.all([
        loadQueue(props.config, accessToken, props.httpFetch),
        loadPostings(props.config, accessToken, {}, props.httpFetch),
        loadCompanies(props.config, accessToken, props.httpFetch),
        loadCriteria(props.config, accessToken, props.httpFetch),
        loadCandidates(props.config, accessToken, props.httpFetch),
      ]);
      // The same race as `refresh()`'s token check, one await later: a
      // sign-out on this tab while the four reads are in flight has already
      // run `clearReads`, and these rows belong to the account that just
      // left. Neither the screen nor the reads cache may take them.
      if (!refreshStillApplies(readFor, session.value)) return;
      queueResult.value = queue;
      postingsResult.value = postings;
      companiesResult.value = companies;
      criteriaResult.value = criteria;
      candidatesResult.value = candidates;
      if (queue.ok && postings.ok && companies.ok && criteria.ok && candidates.ok) {
        saveReads(props.store, {
          queue: queue.value,
          postings: postings.value,
          companies: companies.value,
          criteria: criteria.value,
          candidates: candidates.value,
        });
        const outstanding = new Map(decided.value);
        for (const key of applied) outstanding.delete(key);
        decided.value = outstanding;
        const stillDropped = new Map(dropped.value);
        for (const name of committed) stillDropped.delete(name);
        dropped.value = stillDropped;
        added.value = added.value.filter((candidate) => !submitted.has(candidate.id));
      }
    }

    // Awaited when the page has nothing to show yet; run behind the last
    // round's rows when there is one (`reads-cache.ts`).
    async function refresh(): Promise<void> {
      if (session.value === null) return;
      const startedFor = session.value;
      const fresh = await currentSession(props.config, startedFor, props.httpFetch, props.now);
      // A sign-out on this tab (`onSignOut`) can land while the token
      // refresh is in flight; its answer then belongs to a session nobody is
      // using any more, and acting on it would write the signed-out session
      // back. If a new session was adopted after that sign-out (a link or
      // another tab's sign-in, both of which only reach a signed-out tab),
      // the same check keeps the old answer from clobbering it. Another
      // tab's sign-in never interrupts a refresh on its own:
      // `adoptSessionFromOtherTab` does nothing while this tab has a
      // session. `loadAll` repeats the check after its reads.
      if (!refreshStillApplies(startedFor, session.value)) return;
      if (fresh.ok) {
        session.value = fresh.value;
        saveSession(props.store, fresh.value);
        await loadAll(fresh.value);
      } else {
        clearSession(props.store);
        clearReads(props.store);
        session.value = null;
      }
    }

    // Forgotten before it is spent, so a reload never replays a used hash;
    // a link that fails leaves the sign-in form saying why.
    if (props.linkToken !== null) {
      props.forgetLinkToken();
      try {
        const result = await verifyLink(
          props.config,
          props.linkToken,
          props.httpFetch,
          props.now(),
        );
        if (result.ok) {
          // The link may name a different account than the last round read.
          clearReads(props.store);
          saveSession(props.store, result.value);
          session.value = result.value;
        } else {
          signInError.value = result.reason;
        }
      } catch (error) {
        signInError.value = messageOf(error);
      }
    }

    // Shows the last saved round immediately if the store has one, refreshing
    // behind it; otherwise blocks on a fresh one. Shared by the startup path
    // below and by `adoptSessionFromOtherTab`, which runs the same instant
    // this tab first has a `session` to show anything for.
    async function loadInitialRound(): Promise<void> {
      const cached = session.value === null ? null : loadReads(props.store);
      if (cached !== null) {
        queueResult.value = { ok: true, value: cached.queue };
        postingsResult.value = { ok: true, value: cached.postings };
        companiesResult.value = { ok: true, value: cached.companies };
        criteriaResult.value =
          cached.criteria === null
            ? { ok: false, reason: "No criteria row in the last round." }
            : { ok: true, value: cached.criteria };
        candidatesResult.value = { ok: true, value: cached.candidates };
        void runRefresh(refreshing, refresh);
      } else {
        await refresh();
      }
    }

    // The tab that consumed the emailed link saved this; this tab was only
    // ever told to look again, not what to look for.
    async function adoptSessionFromOtherTab(): Promise<void> {
      if (session.value !== null) return;
      const found = loadSession(props.store, props.now());
      if (found === null) return;
      session.value = found;
      signInStage.value = "email";
      signInError.value = null;
      await loadInitialRound();
    }
    props.watchSession(() => {
      void adoptSessionFromOtherTab();
    });

    await loadInitialRound();

    async function onRequest(): Promise<void> {
      signInBusy.value = true;
      signInError.value = null;
      try {
        const result = await requestLink(props.config, email.value, props.httpFetch);
        if (result.ok) {
          signInStage.value = "sent";
        } else {
          signInError.value = result.reason;
        }
      } catch (error) {
        signInError.value = messageOf(error);
      }
      signInBusy.value = false;
    }

    function onRestart(): void {
      signInStage.value = "email";
      signInError.value = null;
    }

    async function onRetry(): Promise<void> {
      await runRefresh(refreshing, refresh);
    }

    function onSignOut(): void {
      clearSession(props.store);
      clearReads(props.store);
      session.value = null;
    }

    function selectTab(id: TabId): void {
      tab.value = id;
      props.rememberTab(id);
    }

    const queuePostings = computed(() =>
      patchedWith(queueResult.value?.ok ? queueResult.value.value : [], decided.value),
    );
    const allPostings = computed(() =>
      patchedWith(postingsResult.value?.ok ? postingsResult.value.value : [], decided.value),
    );
    // Out of the record this round already read, not a second query.
    const actedPostings = computed(() =>
      allPostings.value.filter((posting) => posting.status !== null),
    );
    // A decided row stays in the queue read carrying its new status, so the
    // Companies tab's "n in queue" and the tab pill both count these rather
    // than the round's size. It does not read the search box: that filter
    // lives in QueueView, which AppRoot cannot see, so the pill stays the
    // number waiting on him regardless of what he is typing.
    const waitingPostings = computed(() =>
      queuePostings.value.filter((posting) => posting.status === null),
    );
    const companies = computed(() =>
      droppedWith(companiesResult.value?.ok ? companiesResult.value.value : [], dropped.value),
    );
    const criteria = computed(() => (criteriaResult.value?.ok ? criteriaResult.value.value : null));
    const candidates = computed(() => [
      ...added.value,
      ...(candidatesResult.value?.ok ? candidatesResult.value.value : []),
    ]);

    const queueError = computed(() =>
      queueResult.value && !queueResult.value.ok ? queueResult.value.reason : null,
    );
    const postingsError = computed(() =>
      postingsResult.value && !postingsResult.value.ok ? postingsResult.value.reason : null,
    );
    const companiesError = computed(() =>
      companiesResult.value && !companiesResult.value.ok ? companiesResult.value.reason : null,
    );
    const criteriaError = computed(() =>
      criteriaResult.value && !criteriaResult.value.ok ? criteriaResult.value.reason : null,
    );
    const candidatesError = computed(() =>
      candidatesResult.value && !candidatesResult.value.ok ? candidatesResult.value.reason : null,
    );

    const tabError = computed(() => {
      const errorByTab: Record<TabId, string | null> = {
        queue: queueError.value,
        record: postingsError.value,
        companies: companiesError.value,
        candidates: candidatesError.value,
        criteria: criteriaError.value,
      };
      return errorByTab[tab.value];
    });

    return {
      tab,
      session,
      refreshing,
      signInStage,
      email,
      signInBusy,
      signInError,
      onRequest,
      onRestart,
      onSignOut,
      onRetry,
      selectTab,
      onDecided,
      onDropped,
      onCandidateAdded,
      queuePostings,
      allPostings,
      actedPostings,
      waitingPostings,
      companies,
      criteria,
      candidates,
      candidatesError,
      tabError,
      TABS,
    };
  },
  template: `
    <template v-if="session === null">
      <SignIn
        :stage="signInStage"
        v-model:email="email"
        :busy="signInBusy"
        :error="signInError"
        @request="onRequest"
        @restart="onRestart" />
    </template>
    <template v-else>
      <div class="top">
        <h1>Job search</h1>
        <TabBar
          :current="tab"
          :counts="{ queue: waitingPostings.length }"
          :busy="refreshing"
          @select="selectTab" />
        <p class="sr-only" role="status">{{ refreshing ? "Recounting the queue" : "" }}</p>
        <div class="top-actions">
          <button type="button" class="ghost refresh" :disabled="refreshing" @click="onRetry">{{ refreshing ? "Refreshing…" : "Refresh" }}</button>
          <button type="button" class="ghost sign-out" @click="onSignOut">Sign out</button>
        </div>
      </div>
      <div>
        <p class="error" v-if="tabError">{{ tabError }} <button type="button" class="ghost" :disabled="refreshing" @click="onRetry">Try again</button></p>
        <QueueView
          v-if="tab === 'queue'"
          :postings="queuePostings"
          :config="config"
          :access-token="session.accessToken"
          :comp-floor="criteria === null ? null : criteria.comp_floor"
          :product-words="criteria === null ? [] : criteria.product_words"
          :history="actedPostings"
          :store="store"
          @decided="onDecided" />

        <RecordView
          v-if="tab === 'record'"
          :postings="allPostings"
          :config="config"
          :access-token="session.accessToken"
          :comp-floor="criteria === null ? null : criteria.comp_floor"
          :product-words="criteria === null ? [] : criteria.product_words"
          @decided="onDecided" />

        <CompaniesView
          v-if="tab === 'companies'"
          :companies="companies"
          :queue="waitingPostings"
          :candidates="candidates"
          :config="config"
          :access-token="session.accessToken"
          @dropped="onDropped" />

        <CandidatesView
          v-if="tab === 'candidates'"
          :candidates="candidates"
          :config="config"
          :access-token="session.accessToken"
          @added="onCandidateAdded" />

        <CriteriaView
          v-if="tab === 'criteria' && criteria !== null"
          :criteria="criteria"
          :config="config"
          :access-token="session.accessToken" />
      </div>
    </template>
  `,
});

/**
 * Shown while `AppRoot`'s async `setup()` is still reading the store;
 * without it the page was blank until the slowest read answered. The tabs
 * are drawn, not live.
 */
export const LoadingShell = defineComponent({
  name: "LoadingShell",
  components: { TabBar },
  props: {
    tab: { type: String as PropType<TabId>, default: "queue" },
  },
  template: `
    <div class="top">
      <h1>Job search</h1>
      <TabBar :current="tab" />
    </div>
    <div class="list skeleton" role="status" aria-label="Reading the store…">
      <div class="card skeleton-row" v-for="n in 5" :key="n">
        <span class="skeleton-bar bar-company"></span>
        <span class="skeleton-bar bar-role"></span>
        <span class="skeleton-bar bar-comp"></span>
      </div>
    </div>
  `,
});

/** An unknown value is a stale link, not an error to show. */
export function tabFrom(search: string): TabId {
  const wanted = new URLSearchParams(search).get("tab");
  return TABS.find((entry) => entry.id === wanted)?.id ?? "queue";
}

export function searchFor(id: TabId): string {
  return id === "queue" ? "" : `?tab=${id}`;
}

/** Mounts `AppRoot` under a `Suspense` boundary, required in the browser for its async `setup()`. */
export function mountApp(selector: string, configText: string, store: SessionStore): void {
  const container = document.querySelector(selector);
  if (container === null) return;
  const result = parseConfig(configText);
  if (!result.ok) {
    container.textContent = result.reason;
    return;
  }
  const config = result.config;
  const initialTab = tabFrom(window.location.search);
  const app = createApp({
    name: "Root",
    render: () =>
      h(Suspense, null, {
        default: () =>
          h(AppRoot, {
            config,
            store,
            httpFetch: fetch,
            now: () => Math.floor(Date.now() / 1000),
            initialTab,
            rememberTab: (id: TabId) =>
              window.history.replaceState(null, "", window.location.pathname + searchFor(id)),
            linkToken: linkTokenFrom(window.location.search),
            forgetLinkToken: () =>
              window.history.replaceState(
                null,
                "",
                window.location.pathname + searchFor(initialTab),
              ),
            watchSession: (onChange: () => void) => {
              window.addEventListener("storage", (event) => {
                if (event.key === SESSION_KEY) onChange();
              });
              // A backgrounded tab (iOS Safari freezes one) may never see the
              // `storage` event fire at all; these two catch it up the next
              // time a person actually looks at it.
              document.addEventListener("visibilitychange", () => {
                if (document.visibilityState === "visible") onChange();
              });
              window.addEventListener("focus", onChange);
            },
          }),
        fallback: () => h(LoadingShell, { tab: initialTab }),
      }),
  });
  app.mount(selector);
}
