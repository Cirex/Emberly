
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  secureStoreChunkKey,
  secureStoreChunkMetaKey,
} = require("../lib/secureStoreChunkKeys");

const VALID_SECURE_STORE_KEY = /^[\w.-]+$/;

test("chunked SecureStore keys only use characters Expo SecureStore accepts", () => {
  const keys = [
    secureStoreChunkMetaKey("emberly_resman_session"),
    secureStoreChunkKey("emberly_resman_session", 0, 1),
    secureStoreChunkKey("emberly_resman_session", 12, 2),
  ];

  assert.deepEqual(keys, [
    "emberly_resman_session_chunks",
    "emberly_resman_session_chunk_g1_0",
    "emberly_resman_session_chunk_g2_12",
  ]);

  for (const key of keys) {
    assert.match(key, VALID_SECURE_STORE_KEY);
  }
});
