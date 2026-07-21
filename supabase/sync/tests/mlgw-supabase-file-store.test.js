const assert = require("node:assert/strict");
const test = require("node:test");

const { SupabaseStorageBillFileStore } = require("../src/mlgw/download/supabase-file-store.ts");

/** Fake ServiceClient exposing just the storage upload surface. */
function fakeClient(uploads, failWith = null) {
  return {
    storage: {
      from(bucket) {
        return {
          async upload(path, blob, options) {
            uploads.push({ bucket, path, size: blob.size, contentType: options.contentType });
            return failWith ? { error: { message: failWith } } : { error: null };
          },
        };
      },
    },
  };
}

test("PDF puts upload to the mlgw-bills bucket and return the path", async () => {
  const uploads = [];
  const store = new SupabaseStorageBillFileStore(fakeClient(uploads));
  const path = await store.put("20260713-0013-857716956.pdf", new Uint8Array([1, 2, 3]), "application/pdf");
  assert.equal(path, "20260713-0013-857716956.pdf");
  assert.deepEqual(uploads, [
    { bucket: "mlgw-bills", path: "20260713-0013-857716956.pdf", size: 3, contentType: "application/pdf" },
  ]);
});

test("non-PDF puts persist nothing and return an empty path", async () => {
  const uploads = [];
  const store = new SupabaseStorageBillFileStore(fakeClient(uploads));
  const path = await store.put("20260713-0013-857716956.html", new Uint8Array([1]), "text/html");
  assert.equal(path, "");
  assert.equal(uploads.length, 0);
});

test("name clashes within a run get the -2 suffix like the in-memory store", async () => {
  const uploads = [];
  const store = new SupabaseStorageBillFileStore(fakeClient(uploads));
  assert.equal(await store.put("bill.pdf", new Uint8Array([1]), "application/pdf"), "bill.pdf");
  assert.equal(await store.put("bill.pdf", new Uint8Array([2]), "application/pdf"), "bill-2.pdf");
});

test("upload failure logs and returns an empty path instead of throwing", async () => {
  const uploads = [];
  const logs = [];
  const store = new SupabaseStorageBillFileStore(fakeClient(uploads, "bucket unavailable"), undefined, (m) => logs.push(m));
  const path = await store.put("bill.pdf", new Uint8Array([1]), "application/pdf");
  assert.equal(path, "");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /bucket unavailable/);
});
