
const assert = require("node:assert/strict");
const test = require("node:test");
const { mock } = require("bun:test");

// Stub expo-secure-store with an in-memory map before lib/secureStoreChunks
// is loaded, so the chunking logic can be exercised without a device (and
// without pulling in react-native's Flow-typed entry, which Bun can't parse).
let backing = new Map();
let failOnSet = null;

const secureStoreStub = {
  async getItemAsync(key) {
    return backing.has(key) ? backing.get(key) : null;
  },
  async setItemAsync(key, value) {
    if (failOnSet && failOnSet(key)) {
      throw new Error(`Simulated crash while writing ${key}`);
    }
    backing.set(key, value);
  },
  async deleteItemAsync(key) {
    backing.delete(key);
  },
};

// Bun runtime: intercept the module with bun:test's mock.module (the Node-only
// Module._resolveFilename + require.cache injection is a no-op under Bun). The
// stub's methods read the live `backing` closure, so reset() still works.
mock.module("expo-secure-store", () => ({ ...secureStoreStub, default: secureStoreStub }));

const {
  deleteLargeSecureItemAsync,
  getLargeSecureItemAsync,
  setLargeSecureItemAsync,
} = require("../lib/secureStoreChunks");
const { secureStoreChunkMetaKey } = require("../lib/secureStoreChunkKeys");

function reset() {
  backing = new Map();
  failOnSet = null;
}

test("large values with newlines and surrogate pairs round-trip across chunks", async () => {
  reset();
  const value = `line one\nline two ${"🌸".repeat(1200)}\n${"x".repeat(5000)}`;

  await setLargeSecureItemAsync("emberly_resman_session", value);

  assert.equal(await getLargeSecureItemAsync("emberly_resman_session"), value);
  // Every stored chunk must rejoin without dropping characters, and no chunk
  // may end on a lone surrogate half.
  for (const [key, chunk] of backing) {
    if (!key.includes("_chunk_")) continue;
    assert.equal(/[\uD800-\uDBFF]$/.test(chunk), false, `chunk ${key} ends on a lone surrogate`);
  }
});

test("reads return null when no chunk meta exists", async () => {
  reset();

  assert.equal(await getLargeSecureItemAsync("emberly_resman_session"), null);
});

test("a crash while shrinking a value leaves the old value fully readable", async () => {
  reset();
  const key = "emberly_resman_session";
  const metaKey = secureStoreChunkMetaKey(key);
  const oldValue = "a".repeat(5000); // 3 chunks
  const newValue = "b".repeat(2000); // 2 chunks

  await setLargeSecureItemAsync(key, oldValue);

  // Crash at the commit point: new chunks written, meta pointer not flipped.
  failOnSet = (itemKey) => itemKey === metaKey;
  await assert.rejects(setLargeSecureItemAsync(key, newValue));
  failOnSet = null;

  assert.equal(await getLargeSecureItemAsync(key), oldValue);

  // A subsequent write recovers cleanly.
  await setLargeSecureItemAsync(key, newValue);
  assert.equal(await getLargeSecureItemAsync(key), newValue);
});

test("a crash while growing a value leaves the old value fully readable", async () => {
  reset();
  const key = "emberly_resman_session";
  const oldValue = "a".repeat(2000); // 2 chunks
  const newValue = "b".repeat(5000); // 3 chunks

  await setLargeSecureItemAsync(key, oldValue);

  // Crash partway through writing the new generation's chunks.
  let writes = 0;
  failOnSet = (itemKey) => itemKey.includes("_chunk_") && ++writes > 1;
  await assert.rejects(setLargeSecureItemAsync(key, newValue));
  failOnSet = null;

  assert.equal(await getLargeSecureItemAsync(key), oldValue);

  await setLargeSecureItemAsync(key, newValue);
  assert.equal(await getLargeSecureItemAsync(key), newValue);
});

test("successful writes clean up the previous generation's chunks", async () => {
  reset();
  const key = "emberly_resman_session";

  await setLargeSecureItemAsync(key, "a".repeat(5000));
  await setLargeSecureItemAsync(key, "b".repeat(2000));

  const chunkKeys = [...backing.keys()].filter((itemKey) => itemKey.includes("_chunk_"));
  assert.equal(chunkKeys.length, 2);
  assert.equal(await getLargeSecureItemAsync(key), "b".repeat(2000));
});

test("delete removes the value, its meta, and its chunks", async () => {
  reset();
  const key = "emberly_resman_session";

  await setLargeSecureItemAsync(key, "a".repeat(5000));
  await deleteLargeSecureItemAsync(key);

  assert.equal(await getLargeSecureItemAsync(key), null);
  assert.deepEqual([...backing.keys()], []);
});
