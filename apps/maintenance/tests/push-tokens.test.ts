import { expect, test } from "bun:test";
import { registerPushToken, unregisterPushToken, type FetchLike } from "../lib/api/push-tokens";

const CONFIG = { baseUrl: "https://example.test", token: "eapi_staff" };

/** Records the single request and answers with the given response. */
function fetchStub(respond: () => Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl: FetchLike = (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  return { calls, impl };
}

const okJson = () => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));

test("registerPushToken POSTs the token with bearer auth and platform", async () => {
  const { calls, impl } = fetchStub(okJson);
  const ok = await registerPushToken(
    { token: "ExponentPushToken[abc]", platform: "ios" },
    CONFIG,
    impl,
  );
  expect(ok).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("https://example.test/api/admin/push-tokens");
  expect(calls[0].init?.method).toBe("POST");
  const headers = calls[0].init?.headers as Record<string, string>;
  expect(headers.Authorization).toBe("Bearer eapi_staff");
  expect(headers["Content-Type"]).toBe("application/json");
  expect(JSON.parse(String(calls[0].init?.body))).toEqual({
    token: "ExponentPushToken[abc]",
    platform: "ios",
  });
});

test("registerPushToken is false on an HTTP error", async () => {
  const { impl } = fetchStub(() => Promise.resolve(new Response("nope", { status: 401 })));
  expect(await registerPushToken({ token: "t", platform: "android" }, CONFIG, impl)).toBe(false);
});

test("registerPushToken is false when the body is not the ok contract", async () => {
  const { impl } = fetchStub(() =>
    Promise.resolve(new Response(JSON.stringify({ ok: false }), { status: 200 })),
  );
  expect(await registerPushToken({ token: "t", platform: "ios" }, CONFIG, impl)).toBe(false);
});

test("registerPushToken is false when the network throws (never rethrows)", async () => {
  const { impl } = fetchStub(() => Promise.reject(new Error("offline")));
  expect(await registerPushToken({ token: "t", platform: "ios" }, CONFIG, impl)).toBe(false);
});

test("unregisterPushToken DELETEs the same endpoint with just the token", async () => {
  const { calls, impl } = fetchStub(okJson);
  const ok = await unregisterPushToken({ token: "ExponentPushToken[abc]" }, CONFIG, impl);
  expect(ok).toBe(true);
  expect(calls[0].url).toBe("https://example.test/api/admin/push-tokens");
  expect(calls[0].init?.method).toBe("DELETE");
  const headers = calls[0].init?.headers as Record<string, string>;
  expect(headers.Authorization).toBe("Bearer eapi_staff");
  expect(JSON.parse(String(calls[0].init?.body))).toEqual({ token: "ExponentPushToken[abc]" });
});

test("unregisterPushToken is false on HTTP error and on network failure", async () => {
  const failing = fetchStub(() => Promise.resolve(new Response("gone wrong", { status: 500 })));
  expect(await unregisterPushToken({ token: "t" }, CONFIG, failing.impl)).toBe(false);
  const throwing = fetchStub(() => Promise.reject(new Error("offline")));
  expect(await unregisterPushToken({ token: "t" }, CONFIG, throwing.impl)).toBe(false);
});
