
const assert = require("node:assert/strict");
const test = require("node:test");

const { upsertMirror } = require("../src/db/client.ts");
const { requireEnv, loadResmanCredentials } = require("../src/config/env.ts");

/** Minimal chainable fake of the Supabase query builder. */
function fakeClient(existingKeys = []) {
  const calls = { upserts: [], selects: [], deletes: [] };
  const client = {
    from(table) {
      return {
        upsert(rows, opts) {
          calls.upserts.push({ table, rows, opts });
          return Promise.resolve({ error: null });
        },
        select(col) {
          calls.selects.push({ table, col });
          // Chainable that supports .order()/.range()/.eq() and is awaitable,
          // mirroring the paged key read in upsertMirror.
          const make = (keys) => {
            const chain = {
              order() {
                return chain;
              },
              range(from, to) {
                return make(keys.slice(from, to + 1));
              },
              eq() {
                return chain;
              },
              then(resolve, reject) {
                return Promise.resolve({
                  data: keys.map((k) => ({ [col]: k })),
                  error: null,
                }).then(resolve, reject);
              },
            };
            return chain;
          };
          return make(existingKeys);
        },
        delete() {
          return {
            in(col, chunk) {
              calls.deletes.push({ col, chunk });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
  return { client, calls };
}

test("upsertMirror is a no-op on empty rows (never-delete-on-empty)", async () => {
  const { client, calls } = fakeClient(["a", "b"]);
  const out = await upsertMirror(client, "resman_units", [], {
    conflictColumn: "resman_unit_id",
    deleteMissing: true,
  });
  assert.equal(out.skippedEmpty, true);
  assert.equal(out.upserted, 0);
  assert.equal(calls.upserts.length, 0);
  assert.equal(calls.deletes.length, 0);
});

test("upsertMirror upserts rows batched on the conflict column", async () => {
  const { client, calls } = fakeClient();
  const rows = [{ resman_unit_id: "u1" }, { resman_unit_id: "u2" }];
  const out = await upsertMirror(client, "resman_units", rows, { conflictColumn: "resman_unit_id" });
  assert.equal(out.upserted, 2);
  assert.equal(calls.upserts.length, 1);
  assert.equal(calls.upserts[0].opts.onConflict, "resman_unit_id");
});

test("upsertMirror deletes only keys absent from the fresh set", async () => {
  const { client, calls } = fakeClient(["u1", "u2", "stale1", "stale2"]);
  const rows = [{ resman_unit_id: "u1" }, { resman_unit_id: "u2" }];
  const out = await upsertMirror(client, "resman_units", rows, {
    conflictColumn: "resman_unit_id",
    deleteMissing: true,
  });
  assert.equal(out.deletedStale, 2);
  assert.deepEqual(calls.deletes[0].chunk.slice().sort(), ["stale1", "stale2"]);
});

test("requireEnv throws on missing var, returns trimmed value otherwise", () => {
  assert.throws(() => requireEnv({}, "SUPABASE_SERVICE_ROLE_KEY"));
  assert.equal(requireEnv({ FOO: "  bar  " }, "FOO"), "bar");
});

test("loadResmanCredentials defaults account id + subdomain", () => {
  const creds = loadResmanCredentials({ RESMAN_SYNC_USERNAME: "u", RESMAN_SYNC_PASSWORD: "p" });
  assert.equal(creds.username, "u");
  assert.equal(creds.accountId, "1659");
  assert.equal(creds.subdomain, "multisouth");
});

/** Fake client whose chunk upsert fails when the chunk holds a "bad" row, and
 *  whose single-row upsert fails only for the bad row — mimicking a CHECK
 *  violation on one scraped row. */
function quarantineClient(badKey) {
  return {
    from() {
      return {
        upsert(rows) {
          const hasBad = rows.some((r) => r.id === badKey);
          if (rows.length > 1 && hasBad) return Promise.resolve({ error: { message: "check violation" } });
          if (rows.length === 1 && rows[0].id === badKey) return Promise.resolve({ error: { message: "check violation" } });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

test("upsertMirror quarantines one bad row instead of failing the whole batch", async () => {
  const out = await upsertMirror(
    quarantineClient("bad"),
    "resman_units",
    [{ id: "a" }, { id: "bad" }, { id: "c" }],
    { conflictColumn: "id" },
  );
  assert.equal(out.upserted, 2); // a + c persisted; the bad row is skipped
});

test("upsertMirror still throws when every row in a chunk fails (systemic)", async () => {
  const client = {
    from() {
      return { upsert: () => Promise.resolve({ error: { message: "connection reset" } }) };
    },
  };
  await assert.rejects(
    upsertMirror(client, "resman_units", [{ id: "a" }, { id: "b" }], { conflictColumn: "id" }),
    /failed for all/,
  );
});
