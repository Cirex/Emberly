/**
 * The subset of a ResMan unit the search box reads. Kept structural (rather than
 * importing each app's ResmanUnit) so this logic stays framework-free and
 * shared: any object with these fields — including both apps' ResmanUnit — is
 * assignable.
 */
export interface SearchableUnit {
  number: string;
  street?: string | null;
  tenant_names: string[];
}

/**
 * Fold text to a comparable form: accents dropped, punctuation reduced to
 * spaces. The register carries names like "Leonard Mills*", "Felicia Dilworth
 * -Handy" and "Clarissa Turner (Bkrptcy)", so punctuation must never be the
 * reason a guard fails to find someone.
 */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // combining marks, split off by NFD above
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Levenshtein distance, abandoned as soon as it passes `max` — we only care
 * whether a word is within a couple of edits, never how far beyond that. Returns
 * `max + 1` to mean "further than you care about".
 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let bestInRow = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < bestInRow) bestInRow = curr[j];
    }
    // Every path through this row is already over budget; nothing below improves.
    if (bestInRow > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * How far off a word of this length may be. Deliberately mean: three letters
 * get no slack (at that length an edit matches half the register), and nothing
 * ever earns more than two. This is "tolerant of odd spellings", not "finds
 * anything vaguely similar".
 */
function budgetFor(length: number): number {
  if (length < 4) return 0;
  if (length <= 7) return 1;
  return 2;
}

/** Does one typed word land on any word of the haystack? */
export function tokenMatches(token: string, haystack: string[]): boolean {
  // Anything containing a digit is a unit or house number, where 1709 and 1809
  // are different homes. Those match exactly — a fuzzy digit is a wrong door.
  const budget = /\d/.test(token) ? 0 : budgetFor(token.length);

  return haystack.some((word) => {
    if (word.includes(token)) return true;
    return budget > 0 && editDistance(token, word, budget) <= budget;
  });
}

/**
 * Match a unit against the search box: tenant names, unit number and street
 * address. Every word typed must land somewhere, so "smith 1709" narrows rather
 * than widens.
 */
export function unitMatchesSearch(unit: SearchableUnit, query: string): boolean {
  const q = normalize(query);
  if (!q) return true;

  const haystack = normalize([unit.number, unit.street ?? "", ...unit.tenant_names].join(" "))
    .split(" ")
    .filter(Boolean);

  return q
    .split(" ")
    .filter(Boolean)
    .every((token) => tokenMatches(token, haystack));
}
