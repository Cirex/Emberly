const assert = require("node:assert/strict");
const test = require("node:test");

const { textHash } = require("../../../packages/core/src/text-hash.ts");
const {
  planServerTranslations,
  groupByDirection,
  normalizeLang,
} = require("../src/resman/derive/translation-routing.ts");
const { LangblyClient } = require("../src/shared/langbly.ts");
const { translateWorkOrders } = require("../src/resman/jobs/translate-work-orders.ts");

// ── routing ────────────────────────────────────────────────────────────────

test("normalizeLang collapses variants, rejects the unsupported", () => {
  assert.equal(normalizeLang("en-US"), "en");
  assert.equal(normalizeLang("ES"), "es");
  assert.equal(normalizeLang("und"), null);
  assert.equal(normalizeLang("pt"), null);
});

test("planServerTranslations routes each source to the opposite language", () => {
  const plans = planServerTranslations(
    ["English WO", "Nota española", "unbekannt"],
    ["en", "es", "de"],
  );
  assert.deepEqual(plans, [
    { source: "English WO", from: "en", to: "es" },
    { source: "Nota española", from: "es", to: "en" },
  ]);
});

test("planServerTranslations returns nothing on a length mismatch", () => {
  assert.deepEqual(planServerTranslations(["a", "b"], ["en"]), []);
});

test("groupByDirection buckets by from->to", () => {
  const groups = groupByDirection([
    { source: "a", from: "en", to: "es" },
    { source: "b", from: "en", to: "es" },
    { source: "c", from: "es", to: "en" },
  ]);
  assert.deepEqual(groups, [
    { from: "en", to: "es", sources: ["a", "b"] },
    { from: "es", to: "en", sources: ["c"] },
  ]);
});

// ── Langbly client (fake fetch) ──────────────────────────────────────────────

test("LangblyClient builds v2 URLs and parses translations", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      json: async () => ({
        data: { translations: JSON.parse(init.body).q.map((t) => ({ translatedText: `es:${t}` })) },
      }),
    };
  };
  const client = new LangblyClient({
    apiKey: "SECRET",
    baseUrl: "https://api.langbly.com/",
    fetchImpl: fakeFetch,
  });
  const out = await client.translateBatch(["Doors", "Leak"], "en", "es");
  assert.deepEqual(out, ["es:Doors", "es:Leak"]);
  assert.ok(calls[0].url.startsWith("https://api.langbly.com/language/translate/v2?key=SECRET"));
  assert.equal(calls[0].body.target, "es");
});

test("LangblyClient.detect reads the top candidate, tolerates malformed", async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ data: { detections: [[{ language: "es", confidence: 0.9 }], []] } }),
  });
  const client = new LangblyClient({ apiKey: "k", baseUrl: "https://x", fetchImpl: fakeFetch });
  assert.deepEqual(await client.detect(["Hola", "??"]), ["es", "und"]);
});

// ── the job, against in-memory fakes ─────────────────────────────────────────

function fakeSupabase(tables) {
  return {
    from(table) {
      const rows = tables[table] ?? (tables[table] = []);
      return {
        select() {
          return {
            range(from, to) {
              return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
            },
          };
        },
        upsert(incoming, { onConflict }) {
          const keys = onConflict.split(",");
          for (const row of incoming) {
            const idx = rows.findIndex((r) => keys.every((k) => r[k] === row[k]));
            if (idx >= 0) rows[idx] = row;
            else rows.push(row);
          }
          return Promise.resolve({ error: null });
        },
        delete() {
          return {
            in(col, vals) {
              const set = new Set(vals);
              tables[table] = rows.filter((r) => !set.has(r[col]));
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
}

const fakeTranslator = {
  async detect(texts) {
    // Spanish if it has an accented char, else English — enough to exercise both directions.
    return texts.map((t) => (/[áéíóúñ¡¿]/i.test(t) ? "es" : "en"));
  },
  async translateBatch(texts, from, to) {
    return texts.map((t) => `${to}:${t}`);
  },
};

test("job no-ops without a translator", async () => {
  const result = await translateWorkOrders({ supabase: fakeSupabase({}), translator: null });
  assert.equal(result.skippedNoTranslator, true);
  assert.equal(result.translated, 0);
});

test("job translates new prose, skips cached, and reaps stale", async () => {
  const tables = {
    resman_work_orders: [
      { title: "Doors", notes: "my air does not work", completion_notes: "" },
      { title: "Reparación urgente", notes: "", completion_notes: "" },
    ],
    work_order_translations: [
      // A stale row for text no longer present in any work order.
      { source_hash: textHash("OLD REMOVED TEXT"), target_lang: "es", source_lang: "en", translated_text: "es:x", char_count: 3 },
    ],
  };
  const result = await translateWorkOrders({ supabase: fakeSupabase(tables), translator: fakeTranslator });

  assert.equal(result.distinctSources, 3); // Doors, "my air does not work", "Reparación urgente"
  assert.equal(result.translated, 3);
  assert.equal(result.reaped, 1);

  const cache = tables.work_order_translations;
  // Stale row gone; three fresh rows in.
  assert.equal(cache.length, 3);
  const doors = cache.find((r) => r.source_hash === textHash("Doors"));
  assert.equal(doors.target_lang, "es"); // English source → Spanish
  assert.equal(doors.translated_text, "es:Doors");
  const fuga = cache.find((r) => r.source_hash === textHash("Reparación urgente"));
  assert.equal(fuga.target_lang, "en"); // Spanish source → English
});

test("re-running the job translates nothing (content-addressed)", async () => {
  const tables = {
    resman_work_orders: [{ title: "Doors", notes: "", completion_notes: "" }],
    work_order_translations: [],
  };
  const deps = { supabase: fakeSupabase(tables), translator: fakeTranslator };
  await translateWorkOrders(deps);
  const second = await translateWorkOrders(deps);
  assert.equal(second.translated, 0);
  assert.equal(second.alreadyCached, 1);
});
