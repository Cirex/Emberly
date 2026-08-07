/**
 * `.env` parsing and secret classification, shared by the env-sync scripts.
 *
 * Extracted when these scripts moved from bash to TypeScript: `eas-env-sync`
 * and the Coolify sync need byte-identical parsing, and the bash version's
 * rules lived in two places already (a `grep -E` guard, a `%%=`/`#*=` split and
 * two quote-strip passes). One parser, one set of rules, unit-testable.
 */

/** A parsed variable. `value` is never logged — see `formatPlan`. */
export type EnvMap = Map<string, string>;

/**
 * Parse `.env` text into a name → value map.
 *
 * Rules, preserved exactly from the shell original:
 *  - blank lines and `#` comments are ignored
 *  - a line must match `NAME=` to count; anything else is skipped rather than
 *    guessed at (a bare word, a stray `export`, YAML pasted by accident)
 *  - everything after the FIRST `=` is the value, so values may contain `=`
 *  - ONE surrounding pair of matching quotes is stripped
 *  - last assignment wins, matching how a shell would source the file
 */
export function parseEnvFile(text: string): EnvMap {
  const out: EnvMap = new Map();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    out.set(key, stripOneQuotePair(raw));
  }
  return out;
}

/**
 * Strip a single surrounding pair of matching quotes.
 *
 * Deliberately only a MATCHED pair: `"abc` keeps its quote, because a lone
 * quote is far more likely to be part of the value (or a paste error worth
 * seeing) than a delimiter. This is the rule that would have caught the
 * `RESMAN_PROPERTY_ID="489f…"` class of bug had the value come from a file.
 */
function stripOneQuotePair(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Should this variable be stored with restricted visibility?
 *
 * `EXPO_PUBLIC_*` is excluded on purpose even when the name also matches a
 * secret word: Expo inlines those into the client bundle, so marking one secret
 * would imply a confidentiality the shipped app does not have.
 *
 * The word list is EXACTLY the shell original's. Note the gap it leaves: a name
 * ending `_KEY` (SUPABASE_SERVICE_ROLE_KEY, LANGBLY_API_KEY, UNIFI_API_KEY) is
 * classified plaintext. Widening this is a real change, not a port — it would
 * re-push those vars with different visibility on the next sync — so it is
 * deliberately left alone here and called out instead.
 */
export function isSecretName(name: string): boolean {
  if (name.startsWith("EXPO_PUBLIC_")) return false;
  return /TOKEN|SECRET|PASSWORD|PRIVATE/.test(name);
}

export type PlanAction = "ADD" | "UPDATE" | "UNCHANGED" | "ORPHAN" | "DELETE";

export interface PlanEntry {
  name: string;
  action: PlanAction;
  /** Present for ADD/UPDATE only; describes storage, never the value. */
  visibility?: "secret" | "plaintext";
}

/**
 * Diff desired (the file) against remote (the platform).
 *
 * `remoteMasksSecrets` is the EAS behaviour: secret values read back as a
 * placeholder, so equality can never be proven and the entry is always an
 * UPDATE. That is harmless because the push is idempotent, but it must not be
 * mistaken for a real change when reading the plan.
 */
export function buildPlan(
  desired: EnvMap,
  remote: EnvMap,
  opts: { prune: boolean; remoteMasksSecrets?: (value: string) => boolean } = { prune: false },
): PlanEntry[] {
  const plan: PlanEntry[] = [];
  const masked = opts.remoteMasksSecrets ?? (() => false);

  for (const [name, want] of desired) {
    const visibility = isSecretName(name) ? "secret" : "plaintext";
    if (!remote.has(name)) {
      plan.push({ name, action: "ADD", visibility });
      continue;
    }
    const have = remote.get(name)!;
    if (masked(have) || have !== want) {
      plan.push({ name, action: "UPDATE", visibility });
    } else {
      plan.push({ name, action: "UNCHANGED" });
    }
  }

  for (const name of remote.keys()) {
    if (!desired.has(name)) plan.push({ name, action: opts.prune ? "DELETE" : "ORPHAN" });
  }

  return plan;
}

/**
 * Render the plan for a terminal.
 *
 * NAMES AND ACTIONS ONLY — never values. The whole point of this output is that
 * it is safe to paste into a ticket or read over a shared screen, which is what
 * makes `--dry-run` a usable first step rather than a leak.
 */
export function formatPlan(plan: PlanEntry[]): string[] {
  const glyph: Record<PlanAction, string> = {
    ADD: "+", UPDATE: "+", UNCHANGED: "·", ORPHAN: "!", DELETE: "-",
  };
  const note: Record<PlanAction, string> = {
    ADD: "", UPDATE: "", UNCHANGED: "",
    ORPHAN: "  (remote only, not in the file)",
    DELETE: "  (absent from the file)",
  };
  return plan.map((e) => {
    const vis = e.visibility ? ` (${e.visibility})` : "";
    return `  ${glyph[e.action]}  ${e.name.padEnd(42)} ${e.action}${vis}${note[e.action]}`;
  });
}

export function countBy(plan: PlanEntry[]): Record<PlanAction, number> {
  const counts: Record<PlanAction, number> = {
    ADD: 0, UPDATE: 0, UNCHANGED: 0, ORPHAN: 0, DELETE: 0,
  };
  for (const e of plan) counts[e.action] += 1;
  return counts;
}
