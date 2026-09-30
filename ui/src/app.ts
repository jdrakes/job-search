/**
 * The mounted application: sign-in, then five tabs sharing one round of
 * reads. The five reads go out together, but the page waits only on the
 * ones the open tab draws (`TAB_READS`) and draws each of the rest as it
 * lands; a tab whose reads are still out shows the skeleton. A read that
 * fails leaves the other tabs with what they had.
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
import {
  clearReads,
  loadReads,
  READ_NAMES,
  saveRead,
  type ReadName,
  type Reads,
} from "./reads-cache.ts";
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
 * The reads each tab cannot draw without; the page waits on these alone.
 * The Queue's company view also lays the postings read's acted rows under
 * each company as history, but it draws without them and takes them in
 * when that read lands. The Queue tab's count is the queue read's whatever
 * tab is open, and says it is still coming with the ring.
 */
export const TAB_READS: Readonly<Record<TabId, readonly ReadName[]>> = {
  queue: ["queue", "criteria"],
  record: ["postings", "criteria"],
  companies: ["companies", "queue", "candidates"],
  candidates: ["candidates"],
  criteria: ["criteria"],
};

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

/**
 * A round's rows wearing what James has decided since it was read. Both
 * reads go through it: `loadPostings` returns every queue row too, so a
 * posting decided on this page must read the same in the Queue and the
 * Record.
 */
function patchedWith(
  postings: readonly PostingSummary[],
  decided: ReadonlyMap<string, StatusPatch>,
): PostingSummary[] {
  return postings.map((posting) => {
    const patch = decided.get(posting.key);
    return patch ? { ...posting, ...patch } : posting;
  });
}

/** Five grey rows standing in for a list whose read is still out. */
export const SkeletonList = defineComponent({
  name: "SkeletonList",
  template: `
    <div class="list skeleton" role="status" aria-label="Reading the store…">
      <div class="card skeleton-row" v-for="n in 5" :key="n">
        <span class="skeleton-bar bar-company"></span>
        <span class="skeleton-bar bar-role"></span>
        <span class="skeleton-bar bar-comp"></span>
      </div>
    </div>
  `,
});

export const AppRoot = defineComponent({
  name: "AppRoot",
  components: {
    SkeletonList,
    SignIn,
    TabBar,
    QueueView,
    RecordView,
    CompaniesView,
    CandidatesView,
    CriteriaView,
  },
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
    // A queue read is out: the tab pill's number is the last one read until
    // it lands, so the ring stands in its place.
    const recounting = ref(false);

    const results: { [K in ReadName]: Ref<ReadResult<Reads[K]> | null> } = {
      queue: queueResult,
      postings: postingsResult,
      companies: companiesResult,
      criteria: criteriaResult,
      candidates: candidatesResult,
    };

    // What James has decided on this page, laid over both reads until a
    // round comes back carrying it. It lives here rather than in the views
    // so a decision survives the tab switch that unmounts the one he made
    // it in, and so the Queue and the Record never disagree about a row.
    // `unread` holds, per decided key, which of the two reads has not yet
    // come back carrying it; the overlay goes once neither is left.
    const decided = ref<ReadonlyMap<string, StatusPatch>>(new Map());
    const unread = new Map<string, Set<ReadName>>();
    function onDecided(outcome: DecidedOutcome): void {
      decided.value = new Map(decided.value).set(outcome.key, outcome.patch);
      unread.set(outcome.key, new Set<ReadName>(["queue", "postings"]));
    }

    const dropped = ref<ReadonlyMap<string, CompanyDropPatch>>(new Map());
    function onDropped(company: DroppedCompany): void {
      dropped.value = new Map(dropped.value).set(company.name, company.patch);
    }

    // What James has added on this page, laid over the round's own
    // candidates until a round reads them back, the same way a drop is laid
    // over companies: the Candidates panel is a `v-if`, and a list kept
    // there dies with it. Each is the row the insert returned, so it carries
    // the id the store assigned and a later read of it can be recognised.
    const added = ref<readonly Candidate[]>([]);
    function onCandidateAdded(candidate: Candidate): void {
      added.value = [candidate, ...added.value];
    }

    function readerFor<K extends ReadName>(
      name: K,
      accessToken: string,
    ): Promise<ReadResult<Reads[K]>> {
      const { config, httpFetch } = props;
      const readers: { [N in ReadName]: () => Promise<ReadResult<Reads[N]>> } = {
        queue: () => loadQueue(config, accessToken, httpFetch),
        postings: () => loadPostings(config, accessToken, {}, httpFetch),
        companies: () => loadCompanies(config, accessToken, httpFetch),
        criteria: () => loadCriteria(config, accessToken, httpFetch),
        candidates: () => loadCandidates(config, accessToken, httpFetch),
      };
      return readers[name]();
    }

    // The round each read last issued. A read that lands after a later
    // round of the same read was issued is dropped: the later one carries
    // at least as much, and it must not be overwritten by the older answer.
    const issued: Record<ReadName, number> = {
      queue: 0,
      postings: 0,
      companies: 0,
      criteria: 0,
      candidates: 0,
    };

    // Takes an overlay entry out once a read issued after it was made has
    // come back: the read's rows now carry it. Compared by the patch
    // itself, so a key decided again while the read was out stays.
    function pruneOverlays(
      name: ReadName,
      decidedAtIssue: ReadonlyMap<string, StatusPatch>,
      droppedAtIssue: ReadonlyMap<string, CompanyDropPatch>,
      value: Reads[ReadName],
    ): void {
      if (name === "queue" || name === "postings") {
        const outstanding = new Map(decided.value);
        for (const [key, patch] of decidedAtIssue) {
          if (outstanding.get(key) !== patch) continue;
          const left = unread.get(key);
          left?.delete(name);
          if (left === undefined || left.size === 0) {
            outstanding.delete(key);
            unread.delete(key);
          }
        }
        decided.value = outstanding;
      } else if (name === "companies") {
        const stillDropped = new Map(dropped.value);
        for (const [company, patch] of droppedAtIssue) {
          if (stillDropped.get(company) === patch) stillDropped.delete(company);
        }
        dropped.value = stillDropped;
      } else if (name === "candidates") {
        // Keyed on presence rather than on what was outstanding when the
        // read was issued, so an insert that lands while a read is in
        // flight is dropped if that read saw it and kept if it did not.
        const read = new Set((value as Candidate[]).map((candidate) => candidate.id));
        added.value = added.value.filter((candidate) => !read.has(candidate.id));
      }
    }

    async function readOne<K extends ReadName>(name: K, readFor: Session): Promise<void> {
      issued[name] += 1;
      const round = issued[name];
      if (name === "queue") recounting.value = true;
      // Taken before the read is issued: a decision made while it is in
      // flight is not in its response, so it must outlive this read.
      const decidedAtIssue = new Map(decided.value);
      const droppedAtIssue = new Map(dropped.value);
      const result = await readerFor(name, readFor.accessToken);
      // The same race as `refresh()`'s token check, one await later: a
      // sign-out on this tab while the read is in flight has already run
      // `clearReads`, and these rows belong to the account that just left.
      // Neither the screen nor the reads cache may take them.
      if (!refreshStillApplies(readFor, session.value)) return;
      if (round !== issued[name]) return;
      if (name === "queue") recounting.value = false;
      results[name].value = result;
      if (!result.ok) return;
      saveRead(props.store, name, result.value);
      pruneOverlays(name, decidedAtIssue, droppedAtIssue, result.value);
    }

    /**
     * Issues all five reads at once and resolves when the open tab's have
     * landed; the others keep going and each is drawn when it lands.
     */
    async function readRound(readFor: Session): Promise<void> {
      const reads = new Map(READ_NAMES.map((name) => [name, readOne(name, readFor)]));
      await Promise.all(TAB_READS[tab.value].map((name) => reads.get(name)));
    }

    function forgetReads(): void {
      for (const name of READ_NAMES) {
        issued[name] += 1;
        results[name].value = null;
      }
      recounting.value = false;
    }

    // Awaited when the open tab has nothing to show yet; run behind the
    // last rows read when it has (`reads-cache.ts`).
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
      // session. `readOne` repeats the check after its read.
      if (!refreshStillApplies(startedFor, session.value)) return;
      if (fresh.ok) {
        session.value = fresh.value;
        saveSession(props.store, fresh.value);
        await readRound(fresh.value);
      } else {
        clearSession(props.store);
        clearReads(props.store);
        forgetReads();
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

    // Shows the last saved rows immediately and refreshes behind them if the
    // open tab has all it needs among them; otherwise blocks on the open
    // tab's reads. Shared by the startup path below and by
    // `adoptSessionFromOtherTab`, which runs the same instant this tab first
    // has a `session` to show anything for.
    async function loadInitialRound(): Promise<void> {
      const cached = session.value === null ? null : loadReads(props.store);
      if (cached !== null) {
        for (const name of READ_NAMES) {
          const value = cached[name];
          if (value !== undefined) {
            (results[name] as Ref<ReadResult<unknown> | null>).value = { ok: true, value };
          }
        }
      }
      if (TAB_READS[tab.value].every((name) => results[name].value !== null)) {
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
      forgetReads();
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
        // The New group is drawn from the candidates read, so a failed one
        // is said here rather than shown as an empty New group.
        companies: companiesError.value ?? candidatesError.value,
        candidates: candidatesError.value,
        criteria: criteriaError.value,
      };
      return errorByTab[tab.value];
    });

    // The open tab's reads are still out; its panel is the skeleton until
    // they land. Any read that has answered, failed or not, ends it.
    const tabLoading = computed(() =>
      TAB_READS[tab.value].some((name) => results[name].value === null),
    );

    return {
      tab,
      session,
      refreshing,
      recounting,
      tabLoading,
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
          :busy="recounting"
          @select="selectTab" />
        <p class="sr-only" role="status">{{ recounting ? "Recounting the queue" : "" }}</p>
        <div class="top-actions">
          <button type="button" class="ghost refresh" :disabled="refreshing" @click="onRetry">{{ refreshing ? "Refreshing…" : "Refresh" }}</button>
          <button type="button" class="ghost sign-out" @click="onSignOut">Sign out</button>
        </div>
      </div>
      <div>
        <p class="error" v-if="tabError">{{ tabError }} <button type="button" class="ghost" :disabled="refreshing" @click="onRetry">Try again</button></p>
        <SkeletonList v-if="tabLoading && !tabError" />
        <template v-else>
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
          :store="store"
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
        </template>
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
  components: { TabBar, SkeletonList },
  props: {
    tab: { type: String as PropType<TabId>, default: "queue" },
  },
  template: `
    <div class="top">
      <h1>Job search</h1>
      <TabBar :current="tab" />
    </div>
    <SkeletonList />
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
