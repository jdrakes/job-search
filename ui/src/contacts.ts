/**
 * The recruiters James has an actual relationship with, so a search can
 * begin with the people who already know him rather than with a posting.
 * The processor owns everything but five columns; this view edits exactly
 * those five (`note`, the drop, `contacted_at`, `alias_of`) and offers no
 * control for `state` at all, because the hosted grant refuses a write to
 * it and a control that always fails is worse than none.
 */
import { computed, defineComponent, ref, type PropType } from "vue";

import { CONTACT_STATES, type Contact, type ContactState } from "../../src/schema.ts";
import { setContactPatch, type ContactPatch, type WriteResult } from "./api.ts";
import type { AppConfig } from "./config.ts";
import { EmptyState } from "./empty-state.ts";
import { SearchBox } from "./search-box.ts";
import { contains } from "./text-match.ts";
import { Toast, useToast } from "./toast.ts";

const STATE_LABELS: Record<ContactState, string> = {
  target: "Target",
  active: "Active",
  employer: "Employer",
};

export function stateLabelOf(state: ContactState): string {
  return STATE_LABELS[state];
}

/** `last_contact` is a timestamptz; the list shows the date, not the time. */
export function lastContactLabel(contact: Contact): string {
  return contact.last_contact === null ? "—" : contact.last_contact.slice(0, 10);
}

export interface ContactFilters {
  readonly state: ContactState | "";
  readonly query: string;
}

function contactHaystack(contact: Contact): string {
  return [contact.name, contact.company, contact.email]
    .filter((value): value is string => value !== null)
    .join(" ");
}

/** State first, then the search box over name, company and address. */
export function filteredContacts(contacts: readonly Contact[], filters: ContactFilters): Contact[] {
  return contacts
    .filter((contact) => filters.state === "" || contact.state === filters.state)
    .filter((contact) => contains(contactHaystack(contact), filters.query))
    .sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email));
}

export function emptyContactsLabel(filters: ContactFilters): string {
  if (filters.query.trim() !== "") return "Nothing matches.";
  if (filters.state === "") return "No contacts yet.";
  return `No ${filters.state} contacts.`;
}

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

/**
 * Two rows sharing a name on different domains: a recruiter who changed
 * agencies, or two different people, and nothing here decides which. Both
 * rows are marked so James can set `alias_of` himself in the list — a
 * wrong merge is silent, a duplicate is visible, so this does nothing
 * automatically.
 */
export function duplicateEmails(contacts: readonly Contact[]): ReadonlySet<string> {
  const domainsByName = new Map<string, Set<string>>();
  for (const contact of contacts) {
    const name = contact.name?.trim().toLowerCase();
    if (!name) continue;
    const domains = domainsByName.get(name) ?? new Set<string>();
    domains.add(domainOf(contact.email));
    domainsByName.set(name, domains);
  }
  const flagged = new Set<string>();
  for (const contact of contacts) {
    const name = contact.name?.trim().toLowerCase();
    if (!name) continue;
    if ((domainsByName.get(name)?.size ?? 0) > 1) flagged.add(contact.email);
  }
  return flagged;
}

export function dropRefusal(reason: string): string | null {
  return reason.trim() === "" ? "Say why — dropping a contact is a judgement, not a fact." : null;
}

/** What a committed edit hands up; `AppRoot` lays it over the round it holds, the way it does a company's drop. */
export interface PatchedContact {
  readonly email: string;
  readonly patch: ContactPatch;
}

export const ContactsView = defineComponent({
  name: "ContactsView",
  components: { EmptyState, SearchBox, Toast },
  props: {
    contacts: { type: Array as PropType<Contact[]>, required: true },
    config: { type: Object as PropType<AppConfig>, required: true },
    accessToken: { type: String, required: true },
  },
  emits: {
    patched: (_contact: PatchedContact) => true,
  },
  setup(props, { emit }) {
    const { toast, showToast } = useToast();
    const stateFilter = ref<ContactState | "">("target");
    const query = ref("");
    const writing = ref<string | null>(null);
    const writeError = ref<{ email: string; reason: string } | null>(null);
    const droppingEmail = ref<string | null>(null);
    const dropReason = ref("");
    const dropError = ref<string | null>(null);

    const filters = computed<ContactFilters>(() => ({
      state: stateFilter.value,
      query: query.value,
    }));
    const filtered = computed(() => filteredContacts(props.contacts, filters.value));
    const duplicates = computed(() => duplicateEmails(props.contacts));
    const empty = computed(() => emptyContactsLabel(filters.value));

    async function commit(contact: Contact, patch: ContactPatch): Promise<WriteResult> {
      writing.value = contact.email;
      writeError.value = null;
      const result = await setContactPatch(props.config, props.accessToken, contact.email, patch);
      writing.value = null;
      if (result.ok) emit("patched", { email: contact.email, patch });
      else writeError.value = { email: contact.email, reason: result.reason };
      return result;
    }

    function onNoteChange(contact: Contact, value: string): void {
      void commit(contact, { note: value.trim() === "" ? null : value });
    }

    function onAliasChange(contact: Contact, value: string): void {
      void commit(contact, { alias_of: value.trim() === "" ? null : value.trim() });
    }

    function markContacted(contact: Contact): void {
      void commit(contact, { contacted_at: new Date().toISOString() });
    }

    function openDrop(contact: Contact): void {
      droppingEmail.value = contact.email;
      dropReason.value = "";
      dropError.value = null;
    }

    function cancelDrop(): void {
      droppingEmail.value = null;
      dropReason.value = "";
      dropError.value = null;
    }

    async function submitDrop(contact: Contact): Promise<void> {
      const refusal = dropRefusal(dropReason.value);
      if (refusal !== null) {
        dropError.value = refusal;
        return;
      }
      const result = await commit(contact, {
        dropped_at: new Date().toISOString(),
        reason: dropReason.value.trim(),
      });
      if (result.ok) {
        droppingEmail.value = null;
        dropReason.value = "";
        showToast(`Dropped ${contact.name ?? contact.email}.`);
      }
    }

    function errorFor(email: string): string | null {
      return writeError.value?.email === email ? writeError.value.reason : null;
    }

    return {
      STATES: CONTACT_STATES,
      stateFilter,
      query,
      filtered,
      duplicates,
      empty,
      writing,
      droppingEmail,
      dropReason,
      dropError,
      toast,
      stateLabelOf,
      lastContactLabel,
      errorFor,
      onNoteChange,
      onAliasChange,
      markContacted,
      openDrop,
      cancelDrop,
      submitDrop,
    };
  },
  template: `
    <section
      class="contacts"
      role="tabpanel"
      id="panel-contacts"
      aria-labelledby="tab-contacts"
      tabindex="-1">
      <div class="fields">
        <SearchBox label="Search" placeholder="Name, company or email" :value="query" @search="query = $event" />
        <label>
          <span>State</span>
          <select :value="stateFilter" @change="stateFilter = $event.target.value">
            <option value="">All</option>
            <option v-for="state in STATES" :key="state" :value="state">{{ stateLabelOf(state) }}</option>
          </select>
        </label>
      </div>
      <EmptyState v-if="filtered.length === 0" :text="empty" />
      <div class="list contacts" v-else>
        <article
          class="card contact"
          v-for="contact in filtered"
          :key="contact.email"
          :class="{ duplicate: duplicates.has(contact.email) }">
          <div class="row">
            <div class="head">
              <span class="name">{{ contact.name ?? contact.email }}</span>
              <span class="email">{{ contact.email }}</span>
              <span class="company" v-if="contact.company">{{ contact.company }}</span>
              <span class="state tag">{{ stateLabelOf(contact.state) }}</span>
              <span class="last-contact">{{ lastContactLabel(contact) }}</span>
              <span class="thread-count">{{ contact.thread_count }} threads</span>
              <span class="duplicate-hint" v-if="duplicates.has(contact.email)">possible duplicate — set alias of</span>
            </div>
          </div>
          <p class="error" role="alert" v-if="errorFor(contact.email)">{{ errorFor(contact.email) }}</p>
          <label class="note">
            <span>Note</span>
            <textarea
              rows="2"
              :value="contact.note ?? ''"
              :disabled="writing === contact.email"
              @change="onNoteChange(contact, $event.target.value)"></textarea>
          </label>
          <label class="alias">
            <span>Alias of</span>
            <input
              type="text"
              :value="contact.alias_of ?? ''"
              :disabled="writing === contact.email"
              @change="onAliasChange(contact, $event.target.value)" />
          </label>
          <p class="why" v-if="contact.dropped_at !== null">Dropped — {{ contact.reason }}</p>
          <div class="acts" v-else-if="droppingEmail !== contact.email">
            <button type="button" class="ghost" :disabled="writing === contact.email" @click="markContacted(contact)">Mark contacted</button>
            <button type="button" class="ghost close" :disabled="writing === contact.email" @click="openDrop(contact)">Drop</button>
          </div>
          <form v-if="droppingEmail === contact.email" @submit.prevent="submitDrop(contact)">
            <p class="error" v-if="dropError">{{ dropError }}</p>
            <label>
              <span>Why drop this contact?</span>
              <textarea v-model="dropReason" rows="2"></textarea>
            </label>
            <div class="actions">
              <button type="button" class="ghost" @click="cancelDrop">Cancel</button>
              <button type="submit" class="primary" :disabled="writing === contact.email">Drop</button>
            </div>
          </form>
        </article>
      </div>
      <Toast :toast="toast" />
    </section>
  `,
});
