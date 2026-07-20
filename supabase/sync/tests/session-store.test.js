
const assert = require("node:assert/strict");
const test = require("node:test");

const { ResManSessionStore, InMemorySessionStorage } = require("../src/resman/session-store");
const { CookieJar } = require("../src/resman/cookies");

// Ported from ResManSessionStoreTests.swift.

function makeCookie(name, value, extra = {}) {
  return {
    name,
    value,
    domain: extra.domain ?? "example.myresman.com",
    path: extra.path ?? "/",
    expires: extra.expires ?? null,
    secure: extra.secure ?? false,
  };
}

test("save then load restores cookies", async () => {
  const backend = new InMemorySessionStorage();
  const store = new ResManSessionStore(backend);

  const writeJar = new CookieJar();
  writeJar.setCookie(makeCookie(".AspNetCore.Cookies", "session-token-abc"));
  writeJar.setCookie(makeCookie(".AspNetCore.Antiforgery", "csrf-xyz"));
  await store.save(writeJar);

  const readJar = new CookieJar();
  await store.load(readJar);

  const loaded = readJar.all();
  assert.equal(loaded.length, 2);
  assert.ok(loaded.some((c) => c.name === ".AspNetCore.Cookies" && c.value === "session-token-abc"));
  assert.ok(loaded.some((c) => c.name === ".AspNetCore.Antiforgery" && c.value === "csrf-xyz"));
});

test("load on an empty backend is a no-op", async () => {
  const store = new ResManSessionStore(new InMemorySessionStorage());
  const jar = new CookieJar();
  await store.load(jar);
  assert.ok(jar.isEmpty());
});

test("clear removes cookies from both backend and jar", async () => {
  const backend = new InMemorySessionStorage();
  const store = new ResManSessionStore(backend);

  const jar = new CookieJar();
  jar.setCookie(makeCookie("session", "token"));
  await store.save(jar);

  await store.clear(jar);
  assert.ok(jar.isEmpty());

  const freshJar = new CookieJar();
  await store.load(freshJar);
  assert.ok(freshJar.isEmpty());
});

test("save overwrites the previously saved session", async () => {
  const backend = new InMemorySessionStorage();
  const store = new ResManSessionStore(backend);

  const first = new CookieJar();
  first.setCookie(makeCookie("session", "first"));
  await store.save(first);

  const second = new CookieJar();
  second.setCookie(makeCookie("session", "second"));
  await store.save(second);

  const readJar = new CookieJar();
  await store.load(readJar);
  const loaded = readJar.all();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].value, "second");
});

test("cookies with expiry dates round-trip correctly", async () => {
  const backend = new InMemorySessionStorage();
  const store = new ResManSessionStore(backend);

  const future = Date.now() + 3_600_000;
  const jar = new CookieJar();
  jar.setCookie(makeCookie("expiring", "val", { expires: future }));
  await store.save(jar);

  const readJar = new CookieJar();
  await store.load(readJar);
  const loaded = readJar.all()[0];
  assert.equal(loaded.name, "expiring");
  assert.equal(loaded.expires, future);
});
