/**
 * `.env` parsing and secret classification, shared by the env-sync scripts.
 *
 * Extracted when these scripts moved from bash to TypeScript: `eas-env-sync`
 * and the Coolify sync need byte-identical parsing, and the bash version's
 * rules lived in two places already (a `grep -E` guard, a `%%=`/`#*=` split and
 * two quote-strip passes). One parser, one set of rules, unit-testable.
 *
 * Plain ESM with JSDoc types rather than TypeScript: Bun runs it directly, and
 * the annotations still give editors and `tsc --checkJs` something to work with
 * without a compile step.
 */

/** @typedef {Map<string, string>} EnvMap A parsed variable map; values are never logged — see `formatPlan`. */

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
/** @param {string} text @returns {EnvMap} */
export function parseEnvFile(text) {
  /** @type {EnvMap} */
  const out = new Map();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    out.set(key, stripInlineComment(raw));
  }
  return out;
}

/**
 * Strip an unquoted trailing `# comment`, then one surrounding quote pair.
 *
 * Bun's `--env-file` and every dotenv implementation drop a trailing comment,
 * so a value read at runtime is NOT what a naive split on the first `=` gives.
 * Four lines in apps/web/.env.production carry one, including SUPABASE_URL —
 * without this, `env:eas` / `env:coolify` would push
 * "https://….supabase.co          # [RUNTIME] server-only…" as the value and
 * the deployed app would get a URL that cannot resolve.
 *
 * A `#` INSIDE quotes is part of the value (passwords contain them), and a `#`
 * with no leading whitespace is too — `a#b` is one token, not a comment.
 */
function stripInlineComment(raw) {
  const value = raw.trimStart();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const close = value.indexOf(quote, 1);
    if (close !== -1) return value.slice(1, close);
    return stripOneQuotePair(raw);
  }
  const comment = /\s#/.exec(value);
  const body = comment ? value.slice(0, comment.index) : value;
  return stripOneQuotePair(body.trimEnd());
}

/**
 * Strip a single surrounding pair of matching quotes.
 *
 * Deliberately only a MATCHED pair: `"abc` keeps its quote, because a lone
 * quote is far more likely to be part of the value (or a paste error worth
 * seeing) than a delimiter. This is the rule that would have caught the
 * `RESMAN_PROPERTY_ID="489f…"` class of bug had the value come from a file.
 */
function stripOneQuotePair(value) {
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
export function isSecretName(name) {
  if (name.startsWith("EXPO_PUBLIC_")) return false;
  return /TOKEN|SECRET|PASSWORD|PRIVATE/.test(name);
}

/** @typedef {"ADD"|"UPDATE"|"UNCHANGED"|"ORPHAN"|"DELETE"} PlanAction */
/**
 * @typedef {object} PlanEntry
 * @property {string} name
 * @property {PlanAction} action
 * @property {"secret"|"plaintext"} [visibility] Present for ADD/UPDATE only;
 *   describes storage, never the value.
 */

/**
 * Diff desired (the file) against remote (the platform).
 *
 * `remoteMasksSecrets` is the EAS behaviour: secret values read back as a
 * placeholder, so equality can never be proven and the entry is always an
 * UPDATE. That is harmless because the push is idempotent, but it must not be
 * mistaken for a real change when reading the plan.
 */
/**
 * @param {EnvMap} desired
 * @param {EnvMap} remote
 * @param {{prune: boolean, remoteMasksSecrets?: (value: string) => boolean, visibility?: boolean}} opts
 * @returns {PlanEntry[]}
 */
export function buildPlan(
  desired,
  remote,
  opts
 = { prune: false },
) {
  /** @type {PlanEntry[]} */
  const plan = [];
  const masked = opts.remoteMasksSecrets ?? (() => false);
  const showVisibility = opts.visibility ?? false;

  for (const [name, want] of desired) {
    const visibility = !showVisibility ? undefined : isSecretName(name) ? "secret" : "plaintext";
    if (!remote.has(name)) {
      plan.push({ name, action: "ADD", visibility });
      continue;
    }
    const have = remote.get(name);
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
/**
 * @param {PlanEntry[]} plan
 * @param {(entry: PlanEntry) => string | undefined} [annotate] Extra per-entry
 *   tag, e.g. Coolify's build-time flag. Names only, no values.
 * @returns {string[]}
 */
export function formatPlan(plan, annotate) {
  /** @type {Record<PlanAction, string>} */
  const glyph = {
    ADD: "+", UPDATE: "+", UNCHANGED: "·", ORPHAN: "!", DELETE: "-",
  };
  /** @type {Record<PlanAction, string>} */
  const note = {
    ADD: "", UPDATE: "", UNCHANGED: "",
    ORPHAN: "  (remote only, not in the file)",
    DELETE: "  (absent from the file)",
  };
  return plan.map((e) => {
    const tag = e.visibility ?? annotate?.(e);
    return `  ${glyph[e.action]}  ${e.name.padEnd(42)} ${e.action}${tag ? ` (${tag})` : ""}${note[e.action]}`;
  });
}

/** @param {PlanEntry[]} plan @returns {Record<PlanAction, number>} */
export function countBy(plan) {
  /** @type {Record<PlanAction, number>} */
  const counts = {
    ADD: 0, UPDATE: 0, UNCHANGED: 0, ORPHAN: 0, DELETE: 0,
  };
  for (const e of plan) counts[e.action] += 1;
  return counts;
}
