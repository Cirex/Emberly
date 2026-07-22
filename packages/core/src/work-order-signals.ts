// work-order-signals.ts (promoted from apps/maintenance/lib/derived/wo-engine.ts)
//
// Faithful 1:1 TypeScript port of the Swift work-order tagging + callback /
// duplicate-detection engine.
//
// Swift source:
//   /Users/benjamin/Documents/Projects/XMS/XMS copy 2/XMS/Core/Services/ResMan/ResManWorkOrders.swift
//     - enum WorkOrderDuplicateDetector (+ helpers)
//     - ResManClient.deriveWorkOrderTags(title:description:category:)
//   Enum raw values from:
//   /Users/benjamin/Documents/Projects/XMS/XMS copy 2/XMS/Core/Models/WorkOrder.swift
//     - enum WorkOrderCallbackStatus (none/possible/confirmed/dismissed)
//     - enum WorkOrderCallbackSource (engine/manual)
//
// This module is dependency-free (no react-native/expo/skia). It computes the
// derived signals that populate the currently-empty DB columns (is_duplicate,
// callback_status, callback_matched_work_order_id) from parsed work orders.
//
// Phrase tables, thresholds, weights, time windows, and precedence are preserved
// verbatim from the Swift. See the report notes for the (small) intentional
// divergences: makeReady is absent from EngineOrder so shouldEvaluate cannot
// filter make-ready orders, and calendar-day math uses UTC day indices rather
// than Swift's Calendar.current local timezone.

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Minimal work-order shape the engine needs. Caller adapts app types to this. */
export interface EngineOrder {
  id: string; // resman_work_order_id (Swift resmanID)
  unitNumber: string; // Swift unit reference / unitId
  status: string;
  title: string;
  description: string; // Swift workOrderDescription  (our raw.notes)
  category: string;
  tags: string[]; // derived tags (deriveWorkOrderTags output)
  completionNotes: string; // Swift technicianNotes  (our raw.completion_notes)
  reportedAt: number | null; // epoch ms  (Swift dateReported)
  completedAt: number | null; // epoch ms  (Swift dateCompleted)
}

/** The per-order signal the batch pass assigns. */
export interface WorkOrderSignal {
  isDuplicate: boolean;
  callbackStatus: string; // WorkOrderCallbackStatus raw value: "none" | "possible" | "confirmed" | "dismissed"
  callbackMatchedId: string; // matched work order id, or ""
}

// WorkOrderCallbackStatus raw values (Swift String enum, no explicit rawValue → case name).
const CALLBACK_STATUS_NONE = "none";
const CALLBACK_STATUS_POSSIBLE = "possible";
// "confirmed" / "dismissed" are manual-only states; the engine never emits them on a fresh pass.

// ---------------------------------------------------------------------------
// Set helpers
// ---------------------------------------------------------------------------

function intersection<T>(a: Set<T>, b: Set<T>): Set<T> {
  const out = new Set<T>();
  for (const v of a) if (b.has(v)) out.add(v);
  return out;
}

function union<T>(a: Set<T>, b: Set<T>): Set<T> {
  const out = new Set<T>(a);
  for (const v of b) out.add(v);
  return out;
}

function subtracting<T>(a: Set<T>, b: Set<T>): Set<T> {
  const out = new Set<T>();
  for (const v of a) if (!b.has(v)) out.add(v);
  return out;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// workOrderDuplicateTokenWeight
// ---------------------------------------------------------------------------

const LOW_SIGNAL_TOKENS = new Set<string>([
  "additional", "call", "check", "fix", "here", "information", "issue", "look", "maintenance",
  "note", "notes", "open", "problem", "repair", "replace", "request", "resident", "room", "send",
  "someone", "tenant", "that", "when", "will", "you",
]);

const TOKEN_WEIGHTS: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  const assign = (tokens: string[], weight: number) => {
    for (const t of tokens) m[t] = weight;
  };
  assign(["ac"], 3);
  assign(["air", "bathroom", "cold", "cool", "heat", "heater", "hot", "key", "slow", "tub", "water"], 2);
  assign(
    ["bathtub", "breaker", "broken", "conditioner", "door", "drain", "floor", "knob", "lightfixture", "sink", "window"],
    3,
  );
  assign(
    ["clog", "dishwasher", "electrical", "flooring", "freezer", "fridge", "mailbox", "outlet", "pest", "power", "powerissue", "range", "rathole", "stove", "thermostat"],
    4,
  );
  assign(
    ["hotwater", "hvac", "leak", "mailboxdoor", "mailboxkey", "mailboxlock", "notcooling", "refrigerator", "roach", "rodent", "sparking", "squirrelchew", "toilet"],
    5,
  );
  return m;
})();

function workOrderDuplicateTokenWeight(token: string): number {
  if (LOW_SIGNAL_TOKENS.has(token)) return 0;
  const explicit = TOKEN_WEIGHTS[token];
  if (explicit !== undefined) return explicit;
  return token.length >= 7 ? 2 : 1;
}

// ---------------------------------------------------------------------------
// Fingerprint + constants (WorkOrderDuplicateDetector)
// ---------------------------------------------------------------------------

interface WorkOrderDuplicateFingerprint {
  normalizedTitle: string;
  normalizedCombined: string;
  titleTokens: Set<string>;
  significantTokens: Set<string>;
  issueSignatures: Set<string>;
}

const CALLBACK_ENGINE_VERSION = "possible-callback-v2";

const OPEN_STATUSES = new Set<string>([
  "submitted", "not started", "scheduled", "in progress", "on hold", "open",
]);

const STOP_WORDS = new Set<string>([
  "a", "all", "an", "and", "again", "also", "at", "be", "because", "but", "by",
  "come", "coming", "down", "first", "for", "from", "has", "have", "i", "if",
  "in", "into", "is", "isn", "isnt", "it", "its", "moved", "move", "my", "need",
  "needs", "not", "of", "on", "or", "our", "out", "please", "properly", "still",
  "stay", "staying", "t", "the", "their", "there", "this", "to", "unable", "unit",
  "up", "with", "work", "working", "your",
]);

const IGNORED_NORMALIZED_TITLES = new Set<string>([
  "trash out",
  "punch",
  "final unit walk inspection",
  "rekey and reassign traka",
  "touch up painting",
  "clean replace repair flooring",
]);

const NORMALIZED_PHRASE_REPLACEMENTS: Array<[string, string]> = [
  ["air conditioner", "hvac"],
  ["air condition", "hvac"],
  ["a c", "hvac"],
  ["a/c", "hvac"],
  ["ac unit", "hvac"],
  ["ac not working", "notcooling"],
  ["air not working", "notcooling"],
  ["air is not working", "notcooling"],
  ["air not getting cold", "notcooling"],
  ["air does not work", "notcooling"],
  ["air doesn t work", "notcooling"],
  ["air went out", "notcooling"],
  ["heat and air went out", "noheat notcooling"],
  ["heating and air went out", "noheat notcooling"],
  ["not getting cold", "notcooling"],
  ["not cooling", "notcooling"],
  ["no cool", "notcooling"],
  ["no air", "notcooling"],
  ["without air", "notcooling"],
  ["no heat", "noheat"],
  ["without heat", "noheat"],
  ["hot water heater", "hotwater"],
  ["hot water tank", "hotwater"],
  ["water heater", "hotwater"],
  ["hot water", "hotwater"],
  ["not draining", "notdraining"],
  ["wont drain", "notdraining"],
  ["won t drain", "notdraining"],
  ["will not drain", "notdraining"],
  ["slow draining", "slowdrain"],
  ["slow drain", "slowdrain"],
  ["drain slow", "slowdrain"],
  ["drains slow", "slowdrain"],
  ["wall socket", "outlet"],
  ["laundry socket", "outlet"],
  ["light fixture", "lightfixture"],
  ["light fixtures", "lightfixture"],
  ["breaker box", "breaker"],
  ["rat hole", "rathole"],
  ["rat holes", "rathole"],
  ["holes around pipes", "rathole"],
  ["hole around pipes", "rathole"],
  ["squirrel chewed", "squirrelchew"],
  ["power outage", "powerissue"],
  ["power out", "powerissue"],
  ["electricity cutting on and off", "powerissue"],
  ["electricity is cutting on and off", "powerissue"],
  ["mail box key", "mailboxkey"],
  ["mailbox key", "mailboxkey"],
  ["mail box lock", "mailboxlock"],
  ["mailbox lock", "mailboxlock"],
  ["mail box door", "mailboxdoor"],
  ["mailbox door", "mailboxdoor"],
  ["mail slot", "mailboxdoor"],
  ["mail slot door", "mailboxdoor"],
  ["parcel locker", "mailbox"],
  ["parcel box", "mailbox"],
  ["mail box", "mailbox"],
  ["cluster box", "mailbox"],
];

const CANONICAL_TAG_TOKENS: Record<string, string[]> = {
  "Mail Box": ["mailbox", "mailboxkey", "mailboxlock", "mailboxdoor"],
  "Electrical": ["electrical", "outlet", "power", "powerissue", "sparking", "breaker", "lightfixture"],
  "HVAC": ["hvac", "heat", "cool", "notcooling", "noheat"],
  "Dishwasher": ["dishwasher"],
  "Range": ["range", "stove"],
  "Refrigerator": ["refrigerator", "fridge", "freezer"],
  "Broken Window": ["window"],
  "No Hot Water": ["hotwater"],
  "Rodents": ["rodent", "rathole", "squirrelchew"],
  "Pests": ["pest", "roach", "cockroach", "bedbug", "ant", "flea"],
};

const BROAD_CALLBACK_TAGS = new Set<string>(["Leaks", "Equipment"]);

function callbackIssueSignatures(
  normalizedText: string,
  tokens: Set<string>,
  tags: string[],
): Set<string> {
  const tagSet = new Set(tags);
  const signatures = new Set<string>();

  if (tagSet.has("HVAC")) signatures.add("hvac");
  if (tagSet.has("No Hot Water")) signatures.add("hotwater");
  if (tagSet.has("Range")) signatures.add("range");
  if (tagSet.has("Clogs")) signatures.add("drainclog");
  if (tagSet.has("Dishwasher")) signatures.add("dishwasher");
  if (tagSet.has("Refrigerator")) signatures.add("refrigerator");
  if (tagSet.has("Mail Box")) signatures.add("mailbox");

  if (tokens.has("thermostat")) {
    signatures.add("hvac");
    signatures.add("thermostat");
  }
  if (tokens.has("hotwater")) {
    signatures.add("hotwater");
  }
  if (
    intersection(tokens, new Set(["notcooling", "hvac"])).size > 0 ||
    normalizedText.includes("air went out") ||
    normalizedText.includes("air not working") ||
    (tokens.has("air") && intersection(tokens, new Set(["cool", "cold"])).size > 0)
  ) {
    signatures.add("hvac");
    signatures.add("hvac-cooling");
  }
  if (
    intersection(tokens, new Set(["noheat", "heat", "heater", "furnace"])).size > 0 &&
    !tokens.has("hotwater")
  ) {
    signatures.add("hvac");
    signatures.add("hvac-heat");
  }
  if (intersection(tokens, new Set(["range", "stove", "oven", "burner"])).size > 0) {
    signatures.add("range");
  }
  if (intersection(tokens, new Set(["dishwasher"])).size > 0) {
    signatures.add("dishwasher");
  }
  if (intersection(tokens, new Set(["refrigerator", "fridge", "freezer"])).size > 0) {
    signatures.add("refrigerator");
  }
  if (intersection(tokens, new Set(["mailbox", "mailboxkey", "mailboxlock", "mailboxdoor"])).size > 0) {
    signatures.add("mailbox");
  }

  const hasDrainFixture =
    intersection(
      tokens,
      new Set(["drain", "slowdrain", "notdraining", "sink", "toilet", "tub", "bathtub", "shower", "sewer"]),
    ).size > 0;
  const hasDrainSymptom =
    intersection(
      tokens,
      new Set(["clog", "clogg", "slow", "slowdrain", "notdraining", "backup", "backed", "overflow", "flush"]),
    ).size > 0;
  if (hasDrainFixture && hasDrainSymptom) {
    signatures.add("drainclog");
  }

  return signatures;
}

// Swift normalizeText: localizedLowercase → replace any scalar that is NOT
// alphanumeric-or-whitespace with a space → phrase replacements → collapse
// double spaces → trim.
function normalizeText(text: string): string {
  const lowered = text.toLowerCase();
  let normalized = lowered.replace(/[^\p{L}\p{N}\s]/gu, " ");
  for (const [source, replacement] of NORMALIZED_PHRASE_REPLACEMENTS) {
    normalized = normalized.split(source).join(replacement);
  }
  while (normalized.includes("  ")) {
    normalized = normalized.split("  ").join(" ");
  }
  return normalized.trim();
}

function singularizeToken(token: string): string {
  if (token.length <= 4) return token;
  if (token.endsWith("ies")) {
    return token.slice(0, -3) + "y";
  }
  if (token.endsWith("ing") && token.length > 5) {
    return token.slice(0, -3);
  }
  if (token.endsWith("ed") && token.length > 4) {
    return token.slice(0, -2);
  }
  if (token.endsWith("es") && token.length > 4) {
    return token.slice(0, -2);
  }
  if (token.endsWith("s") && token.length > 4) {
    return token.slice(0, -1);
  }
  return token;
}

function tokenize(text: string): string[] {
  return text
    .split(" ")
    .map((t) => singularizeToken(t))
    .filter(
      (token) => token.length >= 2 && !STOP_WORDS.has(token) && /\p{L}/u.test(token),
    );
}

function fingerprint(title: string, description: string, tags: string[]): WorkOrderDuplicateFingerprint {
  const normalizedTitle = normalizeText(title);
  const normalizedDescription = normalizeText(description);
  const combined = [normalizedTitle, normalizedDescription].filter((s) => s.length > 0).join(" ").trim();

  const titleTokens = new Set(tokenize(normalizedTitle));
  const textTokens = new Set(tokenize(combined));
  const tagTokens = new Set<string>();
  for (const tag of tags) {
    const canon = CANONICAL_TAG_TOKENS[tag];
    if (canon) for (const tok of canon) tagTokens.add(tok);
  }
  const significantTokens = union(textTokens, tagTokens);

  return {
    normalizedTitle,
    normalizedCombined: combined,
    titleTokens,
    significantTokens,
    issueSignatures: callbackIssueSignatures(combined, significantTokens, tags),
  };
}

function fingerprintFor(o: EngineOrder): WorkOrderDuplicateFingerprint {
  return fingerprint(o.title, o.description, o.tags);
}

// Swift daysBetween: abs of Calendar.current dateComponents([.day]). We use UTC
// day-span floor (see header note about timezone divergence).
function daysBetween(lhs: number | null, rhs: number | null): number | null {
  if (lhs === null || rhs === null) return null;
  return Math.floor(Math.abs(lhs - rhs) / 86_400_000);
}

// Swift startOfDay-based day index (used by the callback date math). UTC-based.
function dayIndex(ms: number): number {
  return Math.floor(ms / 86_400_000);
}

function isOpenStatus(status: string): boolean {
  return OPEN_STATUSES.has(status.toLowerCase());
}

function isCompletedCallbackStatus(status: string): boolean {
  const s = status.toLowerCase();
  return s === "completed" || s === "closed";
}

function isCallbackAnalyticsCandidateStatus(status: string): boolean {
  return isOpenStatus(status) || isCompletedCallbackStatus(status);
}

function callbackMatchIdentifier(o: EngineOrder): string {
  // Swift: resmanID trimmed if non-empty, else number trimmed. EngineOrder has
  // only `id` (resman_work_order_id); we have no separate "number" column.
  return o.id.trim();
}

function completionNoteIndicatesDuplicateClosure(note: string): boolean {
  const normalizedNote = normalizeText(note);
  if (normalizedNote.length === 0) return false;

  const negatedDuplicatePhrases = [
    "not duplicate",
    "not a duplicate",
    "no duplicate",
    "isnt duplicate",
    "isnt a duplicate",
    "is not duplicate",
    "is not a duplicate",
  ];
  if (negatedDuplicatePhrases.some((p) => normalizedNote.includes(p))) {
    return false;
  }

  const duplicateClosureTokens = new Set<string>(["duplicate", "dupe", "dup"]);
  const duplicateClosurePhrases = [
    "same work order",
    "same wo",
    "same ticket",
    "added to another work order",
    "added to another wo",
    "added on another work order",
    "added on another wo",
    "moved to another work order",
    "moved to another wo",
    "combined with another work order",
    "combined with another wo",
    "combined into another work order",
    "combined into another wo",
    "attached to another work order",
    "attached to another wo",
    "already has work order",
    "already has wo",
    "already submitted",
    "existing work order",
    "existing wo",
  ];
  const noteTokens = new Set(normalizedNote.split(" "));

  return (
    intersection(noteTokens, duplicateClosureTokens).size > 0 ||
    duplicateClosurePhrases.some((p) => normalizedNote.includes(p))
  );
}

// Swift unitIdentityKey: unit?.unitId → normalizeText(unitReference) → wo:resmanID.
// EngineOrder carries the resolved unit number; reproduce the unitRef path plus
// the per-order fallback so blank units never group together.
function unitIdentityKey(o: EngineOrder): string {
  const normalizedReference = normalizeText(o.unitNumber);
  return normalizedReference.length === 0 ? `wo:${o.id}` : `unitRef:${normalizedReference}`;
}

// Swift shouldEvaluate also rejects makeReady == "Yes"; EngineOrder has no
// makeReady field, so that branch cannot be reproduced (see header note).
function shouldEvaluate(o: EngineOrder): boolean {
  const normalizedTitle = normalizeText(o.title);
  if (IGNORED_NORMALIZED_TITLES.has(normalizedTitle)) {
    return false;
  }
  return normalizedTitle.length > 0;
}

function maxWeight(tokens: Set<string>): number {
  let best = 0;
  for (const t of tokens) {
    const w = workOrderDuplicateTokenWeight(t);
    if (w > best) best = w;
  }
  return best;
}

function sumWeight(tokens: Set<string>): number {
  let total = 0;
  for (const t of tokens) total += workOrderDuplicateTokenWeight(t);
  return total;
}

// ---------------------------------------------------------------------------
// isLikelyDuplicate
// ---------------------------------------------------------------------------

function isLikelyDuplicate(
  lhs: EngineOrder,
  rhs: EngineOrder,
  lhsFingerprint: WorkOrderDuplicateFingerprint,
  rhsFingerprint: WorkOrderDuplicateFingerprint,
): boolean {
  if (!shouldEvaluate(lhs) || !shouldEvaluate(rhs)) return false;
  if (!isOpenStatus(lhs.status) || !isOpenStatus(rhs.status)) return false;

  if (lhsFingerprint.normalizedCombined.length === 0 || rhsFingerprint.normalizedCombined.length === 0) {
    return false;
  }

  const sameTags = lhs.tags.length > 0 && arraysEqual(lhs.tags, rhs.tags);
  const sameTitle =
    lhsFingerprint.normalizedTitle.length > 0 &&
    lhsFingerprint.normalizedTitle === rhsFingerprint.normalizedTitle;
  const sameCombined = lhsFingerprint.normalizedCombined === rhsFingerprint.normalizedCombined;
  const titleContained =
    lhsFingerprint.normalizedTitle.length > 0 &&
    (lhsFingerprint.normalizedCombined.includes(rhsFingerprint.normalizedTitle) ||
      rhsFingerprint.normalizedCombined.includes(lhsFingerprint.normalizedTitle));

  const sharedTokens = intersection(lhsFingerprint.significantTokens, rhsFingerprint.significantTokens);
  const sharedTitleTokens = intersection(lhsFingerprint.titleTokens, rhsFingerprint.titleTokens);
  const weightedSharedScore = sumWeight(sharedTokens);
  const strongestSharedTokenWeight = maxWeight(sharedTokens);
  const maxTokenCount = Math.max(lhsFingerprint.significantTokens.size, rhsFingerprint.significantTokens.size);
  const overlapRatio = maxTokenCount === 0 ? 0 : sharedTokens.size / maxTokenCount;
  const reportDistance = daysBetween(lhs.reportedAt, rhs.reportedAt);

  let score = 0;

  if (sameCombined) score += 12;
  if (sameTitle) score += 8;
  if (titleContained) score += 4;
  if (sameTags) score += 4;
  score += weightedSharedScore;
  score += sumWeight(sharedTitleTokens);

  if (overlapRatio >= 0.9) score += 5;
  else if (overlapRatio >= 0.75) score += 3;
  else if (overlapRatio >= 0.6) score += 1;

  if (reportDistance !== null) {
    if (reportDistance <= 3) score += 5;
    else if (reportDistance <= 7) score += 4;
    else if (reportDistance <= 14) score += 3;
    else if (reportDistance <= 21) score += 2;
    else if (reportDistance <= 30) score += 1;
  }

  if (sharedTitleTokens.size === 0 && sharedTokens.size < 2 && strongestSharedTokenWeight < 5) {
    return false;
  }

  if (!sameTags && strongestSharedTokenWeight < 3 && sharedTitleTokens.size < 2) {
    return false;
  }

  if (reportDistance === null || reportDistance > 45) {
    return false;
  }

  if (sameCombined) {
    return true; // reportDistance <= 45 guaranteed here
  }
  if (sameTitle && sameTags && reportDistance <= 30) {
    return true;
  }
  if (sameTitle && weightedSharedScore >= 5 && reportDistance <= 30) {
    return true;
  }
  if (sameTags && strongestSharedTokenWeight >= 5 && reportDistance <= 30) {
    return true;
  }
  if (sharedTokens.has("mailbox") && weightedSharedScore >= 6 && reportDistance <= 30) {
    return true;
  }
  if (sameTags && weightedSharedScore >= 8 && reportDistance <= 21) {
    return true;
  }
  if (sameTags) {
    return score >= 13;
  }

  return score >= 16 && strongestSharedTokenWeight >= 3;
}

// ---------------------------------------------------------------------------
// isPossibleCallback / possibleCallbackMatch
// ---------------------------------------------------------------------------

function isPossibleCallback(
  candidate: EngineOrder,
  completed: EngineOrder,
  requiresOpenStatus: boolean,
  candidateFingerprint?: WorkOrderDuplicateFingerprint,
  completedFingerprint?: WorkOrderDuplicateFingerprint,
): boolean {
  if (!shouldEvaluate(candidate) || !shouldEvaluate(completed)) return false;

  const hasAllowedCandidateStatus = requiresOpenStatus
    ? isOpenStatus(candidate.status)
    : isCallbackAnalyticsCandidateStatus(candidate.status);

  if (
    !hasAllowedCandidateStatus ||
    !isCompletedCallbackStatus(completed.status) ||
    candidate.id === completed.id
  ) {
    return false;
  }

  if (
    completionNoteIndicatesDuplicateClosure(candidate.completionNotes) ||
    completionNoteIndicatesDuplicateClosure(completed.completionNotes)
  ) {
    return false;
  }

  const reportedDate = candidate.reportedAt;
  const completedDate = completed.completedAt;
  if (reportedDate === null || completedDate === null) return false;

  if (completed.reportedAt !== null) {
    if (!(dayIndex(reportedDate) >= dayIndex(completed.reportedAt))) {
      return false;
    }
  }

  const daysSinceCompletion = dayIndex(reportedDate) - dayIndex(completedDate);
  if (!(daysSinceCompletion >= 0 && daysSinceCompletion <= 60)) {
    return false;
  }

  const candFp = candidateFingerprint ?? fingerprintFor(candidate);
  const compFp = completedFingerprint ?? fingerprintFor(completed);

  if (candFp.normalizedCombined.length === 0 || compFp.normalizedCombined.length === 0) {
    return false;
  }

  const sameTags = candidate.tags.length > 0 && arraysEqual(candidate.tags, completed.tags);
  const sharedTags = intersection(new Set(candidate.tags), new Set(completed.tags));
  const strongSharedTags = subtracting(sharedTags, BROAD_CALLBACK_TAGS);
  const sameTitle =
    candFp.normalizedTitle.length > 0 && candFp.normalizedTitle === compFp.normalizedTitle;
  const sameCombined = candFp.normalizedCombined === compFp.normalizedCombined;
  const titleContained =
    candFp.normalizedTitle.length > 0 &&
    (candFp.normalizedCombined.includes(compFp.normalizedTitle) ||
      compFp.normalizedCombined.includes(candFp.normalizedTitle));

  const sharedTokens = intersection(candFp.significantTokens, compFp.significantTokens);
  const sharedTitleTokens = intersection(candFp.titleTokens, compFp.titleTokens);
  const sharedIssueSignatures = intersection(candFp.issueSignatures, compFp.issueSignatures);
  const hasSharedCallbackIssueSignal = strongSharedTags.size > 0 || sharedIssueSignatures.size > 0;
  const weightedSharedScore = sumWeight(sharedTokens);
  const strongestSharedTokenWeight = maxWeight(sharedTokens);
  const maxTokenCount = Math.max(candFp.significantTokens.size, compFp.significantTokens.size);
  const overlapRatio = maxTokenCount === 0 ? 0 : sharedTokens.size / maxTokenCount;

  let score = 0;

  if (sameCombined) score += 12;
  if (sameTitle) score += 8;
  if (titleContained) score += 4;
  if (sameTags) score += 4;
  if (strongSharedTags.size > 0) score += 5;
  if (sharedIssueSignatures.size > 0) score += Math.min(6, 3 + sharedIssueSignatures.size);
  score += weightedSharedScore;
  score += sumWeight(sharedTitleTokens);

  if (overlapRatio >= 0.9) score += 5;
  else if (overlapRatio >= 0.75) score += 3;
  else if (overlapRatio >= 0.6) score += 1;

  if (daysSinceCompletion <= 7) score += 5;
  else if (daysSinceCompletion <= 14) score += 4;
  else if (daysSinceCompletion <= 30) score += 2;
  else score += 1;

  if (
    !hasSharedCallbackIssueSignal &&
    sharedTitleTokens.size === 0 &&
    sharedTokens.size < 2 &&
    strongestSharedTokenWeight < 5
  ) {
    return false;
  }

  if (hasSharedCallbackIssueSignal) {
    if (weightedSharedScore < 4 && sharedTitleTokens.size === 0 && strongestSharedTokenWeight < 4) {
      return false;
    }
  } else if (!sameTags && strongestSharedTokenWeight < 3 && sharedTitleTokens.size < 2) {
    return false;
  }

  if (sameCombined) {
    return true;
  }
  if (sameTitle && sameTags) {
    return true;
  }
  if (sameTitle && weightedSharedScore >= 5) {
    return true;
  }
  if (sameTags && strongestSharedTokenWeight >= 5) {
    return true;
  }
  if (sharedTokens.has("mailbox") && weightedSharedScore >= 6) {
    return true;
  }
  if (strongSharedTags.size > 0 && weightedSharedScore >= 4) {
    return true;
  }
  if (sharedIssueSignatures.size > 0 && weightedSharedScore >= 4 && score >= 13) {
    return true;
  }
  if (sameTags) {
    return score >= 13;
  }

  return score >= 16 && strongestSharedTokenWeight >= 3;
}

// Swift isPreferredCallbackMatch: later dateCompleted wins; tie broken by
// callbackMatchIdentifier via localizedStandardCompare (numeric-aware) ascending.
function isPreferredCallbackMatch(lhs: EngineOrder, rhs: EngineOrder): boolean {
  const lhsDate = lhs.completedAt ?? Number.NEGATIVE_INFINITY;
  const rhsDate = rhs.completedAt ?? Number.NEGATIVE_INFINITY;
  if (lhsDate !== rhsDate) {
    return lhsDate > rhsDate;
  }
  return (
    callbackMatchIdentifier(lhs).localeCompare(callbackMatchIdentifier(rhs), undefined, {
      numeric: true,
      sensitivity: "base",
    }) < 0
  );
}

function possibleCallbackMatch(
  order: EngineOrder,
  completedWorkOrders: EngineOrder[],
  requiresOpenStatus: boolean,
  fingerprintCache: Map<string, WorkOrderDuplicateFingerprint>,
): EngineOrder | null {
  let bestMatch: EngineOrder | null = null;
  const candidateFingerprint = fingerprintCache.get(order.id);

  for (const completed of completedWorkOrders) {
    if (
      !isPossibleCallback(
        order,
        completed,
        requiresOpenStatus,
        candidateFingerprint,
        fingerprintCache.get(completed.id),
      )
    ) {
      continue;
    }

    if (bestMatch === null) {
      bestMatch = completed;
      continue;
    }

    if (isPreferredCallbackMatch(completed, bestMatch)) {
      bestMatch = completed;
    }
  }

  return bestMatch;
}

// ---------------------------------------------------------------------------
// Batch pass — computeWorkOrderSignals (markDuplicates + markPossibleCallbacks)
// ---------------------------------------------------------------------------

function groupBy(orders: EngineOrder[], keyFn: (o: EngineOrder) => string): Map<string, EngineOrder[]> {
  const map = new Map<string, EngineOrder[]>();
  for (const o of orders) {
    const key = keyFn(o);
    const bucket = map.get(key);
    if (bucket) bucket.push(o);
    else map.set(key, [o]);
  }
  return map;
}

/**
 * Batch pass: given every work order (already parsed), compute duplicate +
 * callback signals per the Swift markDuplicates / markPossibleCallbacks. Returns
 * a map keyed by work-order id. Pure — does not mutate the input.
 *
 * Scoping (from the Swift markers, single-property data → property filter is a
 * no-op, so grouping is by unit):
 *   - Duplicates: only open-status orders, grouped by unit; pairwise within a
 *     unit group of size > 1; both flagged when isLikelyDuplicate. Report-date
 *     window <= 45 days (see isLikelyDuplicate).
 *   - Callbacks: each open-status order is matched against COMPLETED/CLOSED
 *     orders in the SAME unit; candidate reported on/after the completed order's
 *     reported day, and 0..60 days after the completed order's completion day.
 *     Best match = most-recently completed (id tiebreak). Emits "possible".
 *
 * The engine only emits "none" or "possible"; "confirmed"/"dismissed" are
 * manual states not derivable from a fresh parse.
 */
export function computeWorkOrderSignals(orders: EngineOrder[]): Map<string, WorkOrderSignal> {
  const result = new Map<string, WorkOrderSignal>();
  for (const o of orders) {
    result.set(o.id, {
      isDuplicate: false,
      callbackStatus: CALLBACK_STATUS_NONE,
      callbackMatchedId: "",
    });
  }

  // Fingerprint every order once, up front. Computing a fingerprint runs
  // normalizeText (~50 string passes) + tokenization, so the O(k²) duplicate
  // scan below must NOT recompute per comparison — it reads from this cache, and
  // markPossibleCallbacks reuses the same map.
  const fingerprintCache = new Map<string, WorkOrderDuplicateFingerprint>();
  for (const o of orders) fingerprintCache.set(o.id, fingerprintFor(o));

  // --- markDuplicates ---
  const openOrders = orders.filter((o) => isOpenStatus(o.status));
  const openGroups = groupBy(openOrders, unitIdentityKey);
  for (const group of openGroups.values()) {
    if (group.length <= 1) continue;
    for (let i = 0; i < group.length; i++) {
      const lhs = group[i];
      for (let j = i + 1; j < group.length; j++) {
        const rhs = group[j];
        if (lhs.id === rhs.id) continue;
        if (isLikelyDuplicate(lhs, rhs, fingerprintCache.get(lhs.id)!, fingerprintCache.get(rhs.id)!)) {
          result.get(lhs.id)!.isDuplicate = true;
          result.get(rhs.id)!.isDuplicate = true;
        }
      }
    }
  }

  // --- markPossibleCallbacks ---

  const completedByUnit = groupBy(
    orders.filter((o) => isCompletedCallbackStatus(o.status)),
    unitIdentityKey,
  );

  for (const open of orders) {
    if (!isOpenStatus(open.status)) continue;
    // Fresh compute: no prior confirmed/dismissed state to preserve.
    const unitKey = unitIdentityKey(open);
    const completedUnitOrders = completedByUnit.get(unitKey) ?? [];
    const matched = possibleCallbackMatch(open, completedUnitOrders, true, fingerprintCache);
    if (matched !== null) {
      const sig = result.get(open.id)!;
      sig.callbackStatus = CALLBACK_STATUS_POSSIBLE;
      sig.callbackMatchedId = callbackMatchIdentifier(matched);
    }
  }

  return result;
}
