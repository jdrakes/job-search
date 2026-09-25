/**
 * The criteria row, grouped by what it judges and edited as tag lists, saved
 * as one write that stamps `updated_at`. Saving re-judges every posting at
 * the next run, so the view confirms it and says so next to Save.
 */
import { computed, defineComponent, ref, type PropType } from "vue";

import type { Criteria } from "../../src/schema.ts";
import { saveCriteria, type CriteriaPatch, type WriteResult } from "./api.ts";
import type { AppConfig } from "./config.ts";
import { formatComp } from "./posting.ts";
import { Toast, useToast } from "./toast.ts";

export function parseList(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

export function formatList(items: readonly string[]): string {
  return items.join("\n");
}

/** Null while the field is not a number. */
export function floorLabel(text: string): string | null {
  const value = Number(text);
  if (text.trim() === "" || !Number.isFinite(value)) return null;
  return formatComp(value);
}

export interface CriteriaFormFields {
  readonly levelWords: string;
  readonly roleWords: string;
  readonly excludedTitleWords: string;
  readonly teamNameWords: string;
  readonly excludedStates: string;
  readonly missingLanguages: string;
  readonly compFloor: string;
  readonly excludedLocations: string;
  readonly maxAgeDays: string;
  readonly productWords: string;
  readonly assumedBonusPct: string;
}

export function fieldsFrom(criteria: Criteria): CriteriaFormFields {
  return {
    levelWords: formatList(criteria.level_words),
    roleWords: formatList(criteria.role_words),
    excludedTitleWords: formatList(criteria.excluded_title_words),
    teamNameWords: formatList(criteria.team_name_words),
    excludedStates: formatList(criteria.excluded_states),
    missingLanguages: formatList(criteria.missing_languages),
    compFloor: String(criteria.comp_floor),
    excludedLocations: formatList(criteria.excluded_locations),
    maxAgeDays: criteria.max_age_days === null ? "" : String(criteria.max_age_days),
    productWords: formatList(criteria.product_words),
    assumedBonusPct: criteria.assumed_bonus_pct === null ? "" : String(criteria.assumed_bonus_pct),
  };
}

export type PatchOutcome = { readonly patch: CriteriaPatch } | { readonly error: string };

export function patchFrom(fields: CriteriaFormFields): PatchOutcome {
  const compFloor = Number(fields.compFloor);
  if (fields.compFloor.trim() === "" || !Number.isFinite(compFloor)) {
    return { error: "The comp floor must be a number." };
  }

  let maxAgeDays: number | null = null;
  const maxAgeText = fields.maxAgeDays.trim();
  if (maxAgeText !== "") {
    // Number() reads "1e3" and "0x5A" as finite integers, so a typo could
    // save a 1000-day max age; a day count James types is decimal digits.
    if (!/^\d+$/.test(maxAgeText)) {
      return { error: "The max age must be a whole number of days, or blank for none." };
    }
    maxAgeDays = Number(maxAgeText);
  }

  let assumedBonusPct: number | null = null;
  const bonusText = fields.assumedBonusPct.trim();
  if (bonusText !== "") {
    // Number() reads "1e3" and "0x5A" as finite integers; a percentage James
    // types is decimal digits, 0 to 100.
    if (!/^\d+$/.test(bonusText)) {
      return { error: "The assumed bonus % must be a whole number 0–100, or blank for none." };
    }
    const pct = Number(bonusText);
    if (pct > 100) {
      return { error: "The assumed bonus % must be a whole number 0–100, or blank for none." };
    }
    assumedBonusPct = pct;
  }

  return {
    patch: {
      level_words: parseList(fields.levelWords),
      role_words: parseList(fields.roleWords),
      excluded_title_words: parseList(fields.excludedTitleWords),
      team_name_words: parseList(fields.teamNameWords),
      excluded_states: parseList(fields.excludedStates),
      missing_languages: parseList(fields.missingLanguages),
      comp_floor: compFloor,
      max_age_days: maxAgeDays,
      excluded_locations: parseList(fields.excludedLocations),
      product_words: parseList(fields.productWords),
      assumed_bonus_pct: assumedBonusPct,
    },
  };
}

/**
 * One item at a time, typed into a text field and shown back as a removable
 * chip: adding or dropping a word no longer means finding its line in a
 * multi-line textarea. The list itself stays the same newline-joined string
 * every other piece of this view already speaks, so nothing about
 * `parseList`/`formatList`/`patchFrom` had to change for it.
 */
export const TagInput = defineComponent({
  name: "TagInput",
  props: {
    modelValue: { type: String, required: true },
    addLabel: { type: String, required: true },
  },
  emits: ["update:modelValue"],
  setup(props, { emit }) {
    const draft = ref("");
    const items = computed(() => parseList(props.modelValue));

    function commit(): void {
      const value = draft.value.trim();
      draft.value = "";
      if (value === "" || items.value.includes(value)) return;
      emit("update:modelValue", formatList([...items.value, value]));
    }

    function removeAt(index: number): void {
      emit("update:modelValue", formatList(items.value.filter((_, current) => current !== index)));
    }

    // Enter and comma both commit, the way a chip field is typed anywhere
    // else; Backspace on an empty draft deletes the last chip instead of
    // doing nothing, so a misadded word is one keystroke to undo.
    function onKeydown(event: KeyboardEvent): void {
      if (event.key === "Enter" || event.key === ",") {
        event.preventDefault();
        commit();
      } else if (event.key === "Backspace" && draft.value === "" && items.value.length > 0) {
        removeAt(items.value.length - 1);
      }
    }

    return { draft, items, commit, removeAt, onKeydown };
  },
  template: `
    <div class="tag-editor">
      <ul class="tag-list" v-if="items.length">
        <li class="tag" v-for="(item, index) in items" :key="item">
          <span>{{ item }}</span>
          <button type="button" class="tag-remove" :aria-label="'Remove ' + item" @click="removeAt(index)">×</button>
        </li>
      </ul>
      <input
        type="text"
        class="tag-draft"
        v-model="draft"
        :placeholder="addLabel"
        @keydown="onKeydown"
        @blur="commit" />
    </div>
  `,
});

interface ListFieldSpec {
  readonly key: Exclude<keyof CriteriaFormFields, "compFloor" | "maxAgeDays" | "assumedBonusPct">;
  readonly label: string;
  readonly hint: string;
}

interface FieldGroup {
  readonly title: string;
  readonly hint: string;
  readonly listFields: readonly ListFieldSpec[];
}

/**
 * What each field actually decides, in the terms `judge.ts` uses, so the
 * form explains a criterion instead of just naming it. Order follows the
 * judging pass: title, then location and language, then pay, then the one
 * field (product words) that never drops a posting at all.
 */
const GROUPS: readonly FieldGroup[] = [
  {
    title: "Title",
    hint: "What the posting's title itself must or must not say.",
    listFields: [
      {
        key: "levelWords",
        label: "Level words",
        hint: "A title carrying any one of these whole-word is senior enough on its own.",
      },
      {
        key: "roleWords",
        label: "Role words",
        hint: "A title needs one of these, alongside real engineering work, to pass the role check.",
      },
      {
        key: "excludedTitleWords",
        label: "Excluded title words",
        hint: "A title carrying any of these anywhere is dropped, unless it's also a team name below.",
      },
      {
        key: "teamNameWords",
        label: "Team name words",
        hint: "Excluded title words allowed to appear as a team name, after the role part of the title.",
      },
    ],
  },
  {
    title: "Location",
    hint: "Where the role can be based.",
    listFields: [
      {
        key: "excludedStates",
        label: "Excluded states",
        hint: "Dropped if the posting's body says one of these states is ineligible.",
      },
      {
        key: "excludedLocations",
        label: "Excluded locations",
        hint: "Dropped if the posting is based in one of these and not also in the United States.",
      },
    ],
  },
  {
    title: "Language",
    hint: "What the posting's body can ask of you.",
    listFields: [
      {
        key: "missingLanguages",
        label: "Missing languages",
        hint: "Dropped if the body requires one of these and doesn't welcome it as a nice-to-have.",
      },
    ],
  },
  {
    title: "Ranking only",
    hint: "Never drops a posting — only orders the Queue.",
    listFields: [
      {
        key: "productWords",
        label: "Product words",
        hint: "A title carrying one of these whole-word ranks higher in the Queue.",
      },
    ],
  },
];

export const CriteriaView = defineComponent({
  name: "CriteriaView",
  components: { Toast, TagInput },
  props: {
    criteria: { type: Object as PropType<Criteria>, required: true },
    config: { type: Object as PropType<AppConfig>, required: true },
    accessToken: { type: String, required: true },
    // Overridden in tests, which run with no `window` and must not block on
    // a real confirm dialog; a plain browser mount gets the real one.
    confirm: {
      type: Function as PropType<(message: string) => boolean>,
      default: (message: string) =>
        typeof window === "undefined" ? true : window.confirm(message),
    },
  },
  setup(props) {
    const fields = ref<CriteriaFormFields>(fieldsFrom(props.criteria));
    // What Save last wrote (or the row's own values, before any edit), so
    // Save can stay disabled until something actually changed and reread
    // its own baseline once a write lands rather than the stale one.
    const saved = ref<CriteriaFormFields>(fieldsFrom(props.criteria));
    const busy = ref(false);
    const error = ref<string | null>(null);
    const { toast, showToast } = useToast();

    const dirty = computed(() => JSON.stringify(fields.value) !== JSON.stringify(saved.value));
    const canSubmit = computed(() => !busy.value && dirty.value);
    const floor = computed(() => floorLabel(fields.value.compFloor));

    async function save(): Promise<void> {
      const outcome = patchFrom(fields.value);
      if ("error" in outcome) {
        error.value = outcome.error;
        return;
      }
      if (!props.confirm("Save and re-judge every posting at the next run?")) return;
      error.value = null;
      busy.value = true;
      const written: WriteResult = await saveCriteria(
        props.config,
        props.accessToken,
        props.criteria.id,
        outcome.patch,
      );
      busy.value = false;
      if (written.ok) {
        saved.value = { ...fields.value };
        showToast("Saved.");
      } else {
        error.value = written.reason;
      }
    }

    return {
      fields,
      busy,
      dirty,
      canSubmit,
      error,
      toast,
      save,
      groups: GROUPS,
      floor,
    };
  },
  template: `
    <section class="criteria" role="tabpanel" id="panel-criteria" aria-labelledby="tab-criteria" tabindex="-1">
      <form @submit.prevent="save">
        <p class="error" v-if="error">{{ error }}</p>

        <fieldset class="criteria-group" v-for="group in groups" :key="group.title">
          <legend>{{ group.title }}</legend>
          <p class="hint">{{ group.hint }}</p>
          <div class="field" v-for="field in group.listFields" :key="field.key">
            <span class="field-label">{{ field.label }}</span>
            <p class="field-hint">{{ field.hint }}</p>
            <TagInput
              :model-value="fields[field.key]"
              @update:model-value="fields[field.key] = $event"
              :add-label="'Add to ' + field.label.toLowerCase()" />
          </div>
        </fieldset>

        <fieldset class="criteria-group">
          <legend>Pay &amp; freshness</legend>
          <p class="hint">What settles whether a posting's pay and age are good enough.</p>
          <label class="field">
            <span class="field-label">Comp floor <em class="money" v-if="floor">{{ floor }}</em></span>
            <p class="field-hint">The lowest top-of-band pay that clears on its own, with no bonus.</p>
            <input type="text" inputmode="numeric" v-model="fields.compFloor" />
          </label>
          <label class="field">
            <span class="field-label">Assumed bonus % <em v-if="fields.assumedBonusPct">{{ fields.assumedBonusPct }}%</em></span>
            <p class="field-hint">Applied to a band below the floor as a guess, to ask whether the body's bonus language would still clear it. Blank drops a low band outright.</p>
            <input type="text" inputmode="numeric" v-model="fields.assumedBonusPct" placeholder="blank for none" />
          </label>
          <label class="field">
            <span class="field-label">Max age <em v-if="fields.maxAgeDays">{{ fields.maxAgeDays }} days</em></span>
            <p class="field-hint">Drops a kept posting once it's this many days old. Blank means no limit.</p>
            <input type="text" inputmode="numeric" v-model="fields.maxAgeDays" placeholder="blank for none" />
          </label>
        </fieldset>

        <div class="actions">
          <p class="hint">Saving re-judges every posting at the next run.</p>
          <button type="submit" class="primary" :disabled="!canSubmit">{{ busy ? 'Saving…' : 'Save' }}</button>
        </div>
      </form>
      <Toast :toast="toast" />
    </section>
  `,
});
