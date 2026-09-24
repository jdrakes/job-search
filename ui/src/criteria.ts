/**
 * The criteria row, each field edited as plain text, saved as one write
 * that stamps `updated_at`. Saving re-judges every posting at the next
 * run, so the view says so next to Save.
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

/** Every item and one spare line, never fewer than three rows. */
export function rowsFor(text: string): number {
  return Math.max(3, parseList(text).length + 1);
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

const LIST_FIELDS: readonly {
  readonly key: Exclude<keyof CriteriaFormFields, "compFloor" | "maxAgeDays">;
  readonly label: string;
}[] = [
  { key: "levelWords", label: "Level words" },
  { key: "roleWords", label: "Role words" },
  { key: "excludedTitleWords", label: "Excluded title words" },
  { key: "teamNameWords", label: "Team name words" },
  { key: "excludedStates", label: "Excluded states" },
  { key: "missingLanguages", label: "Missing languages" },
  { key: "excludedLocations", label: "Excluded locations" },
  { key: "productWords", label: "Product words" },
];

export const CriteriaView = defineComponent({
  name: "CriteriaView",
  components: { Toast },
  props: {
    criteria: { type: Object as PropType<Criteria>, required: true },
    config: { type: Object as PropType<AppConfig>, required: true },
    accessToken: { type: String, required: true },
  },
  setup(props) {
    const fields = ref<CriteriaFormFields>(fieldsFrom(props.criteria));
    const busy = ref(false);
    const error = ref<string | null>(null);
    const { toast, showToast } = useToast();

    const canSubmit = computed(() => !busy.value);
    const floor = computed(() => floorLabel(fields.value.compFloor));

    async function save(): Promise<void> {
      const outcome = patchFrom(fields.value);
      if ("error" in outcome) {
        error.value = outcome.error;
        return;
      }
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
        showToast("Saved.");
      } else {
        error.value = written.reason;
      }
    }

    return {
      fields,
      busy,
      canSubmit,
      error,
      toast,
      save,
      listFields: LIST_FIELDS,
      rowsFor,
      floor,
    };
  },
  template: `
    <section class="criteria" role="tabpanel" id="panel-criteria" aria-labelledby="tab-criteria" tabindex="-1">
      <form @submit.prevent="save">
        <p class="error" v-if="error">{{ error }}</p>
        <label v-for="field in listFields" :key="field.key">
          <span>{{ field.label }}</span>
          <textarea v-model="fields[field.key]" :rows="rowsFor(fields[field.key])"></textarea>
        </label>
        <label>
          <span>Comp floor <em class="money" v-if="floor">{{ floor }}</em></span>
          <input type="text" inputmode="numeric" v-model="fields.compFloor" />
        </label>
        <label>
          <span>Max age <em v-if="fields.maxAgeDays">{{ fields.maxAgeDays }} days</em></span>
          <input type="text" inputmode="numeric" v-model="fields.maxAgeDays" placeholder="blank for none" />
        </label>
        <label>
          <span>Assumed bonus % <em v-if="fields.assumedBonusPct">{{ fields.assumedBonusPct }}%</em></span>
          <input type="text" inputmode="numeric" v-model="fields.assumedBonusPct" placeholder="blank for none" />
        </label>
        <div class="actions">
          <p class="hint">Saving re-judges every posting at the next run.</p>
          <button type="submit" class="primary" :disabled="!canSubmit">{{ busy ? 'Saving…' : 'Save' }}</button>
        </div>
      </form>
      <Toast :toast="toast" />
    </section>
  `,
});
