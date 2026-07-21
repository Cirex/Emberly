import { describe, expect, test } from "bun:test";
import {
  listWorkOrderPhotos,
  uploadWorkOrderPhoto,
  type FetchLike,
} from "../lib/api/work-order-photos";

const CONFIG = { baseUrl: "https://example.test", token: "eapi_staff" };

/** Records requests and answers with the given response. */
function fetchStub(respond: () => Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl: FetchLike = (url, init) => {
    calls.push({ url, init });
    return respond();
  };
  return { calls, impl };
}

const created = () =>
  Promise.resolve(
    new Response(
      JSON.stringify({ data: { id: "srv-1", phase: "completion", createdAt: "2026-07-21" } }),
      { status: 201 },
    ),
  );

describe("uploadWorkOrderPhoto", () => {
  test("POSTs base64 JPEG with bearer auth and phase to the photos route", async () => {
    const { calls, impl } = fetchStub(created);
    const outcome = await uploadWorkOrderPhoto("wo 1", "QUJD", "completion", CONFIG, impl);
    expect(outcome).toEqual({ ok: true, serverId: "srv-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://example.test/api/resman/work-orders/wo%201/photos");
    expect(calls[0].init?.method).toBe("POST");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer eapi_staff");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      dataBase64: "QUJD",
      contentType: "image/jpeg",
      phase: "completion",
    });
  });

  test("404 (work order not in the mirror yet) is retryable", async () => {
    const { impl } = fetchStub(() => Promise.resolve(new Response("nope", { status: 404 })));
    expect(await uploadWorkOrderPhoto("wo-1", "QUJD", "after", CONFIG, impl)).toEqual({
      ok: false,
      retry: true,
      status: 404,
    });
  });

  test("5xx and 429 are retryable", async () => {
    for (const status of [500, 503, 429]) {
      const { impl } = fetchStub(() => Promise.resolve(new Response("busy", { status })));
      expect(await uploadWorkOrderPhoto("wo-1", "QUJD", "before", CONFIG, impl)).toEqual({
        ok: false,
        retry: true,
        status,
      });
    }
  });

  test("400/401/403 are fatal — the same request will never succeed", async () => {
    for (const status of [400, 401, 403]) {
      const { impl } = fetchStub(() => Promise.resolve(new Response("rejected", { status })));
      expect(await uploadWorkOrderPhoto("wo-1", "QUJD", "completion", CONFIG, impl)).toEqual({
        ok: false,
        retry: false,
        status,
      });
    }
  });

  test("network failure rethrows so the offline queue holds the entry", async () => {
    const { impl } = fetchStub(() => Promise.reject(new Error("offline")));
    expect(uploadWorkOrderPhoto("wo-1", "QUJD", "completion", CONFIG, impl)).rejects.toThrow(
      "offline",
    );
  });
});

describe("listWorkOrderPhotos", () => {
  test("GETs the photo list with bearer auth and parses the metadata", async () => {
    const { calls, impl } = fetchStub(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                id: "srv-1",
                phase: "completion",
                contentType: "image/jpeg",
                byteSize: 1234,
                createdBy: "Alex Tech",
                createdAt: "2026-07-21",
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    const photos = await listWorkOrderPhotos("wo-1", CONFIG, impl);
    expect(photos).toHaveLength(1);
    expect(photos[0].id).toBe("srv-1");
    expect(photos[0].byteSize).toBe(1234);
    expect(calls[0].url).toBe("https://example.test/api/resman/work-orders/wo-1/photos");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer eapi_staff");
  });

  test("throws on auth and server errors", async () => {
    const unauthorized = fetchStub(() => Promise.resolve(new Response("no", { status: 403 })));
    expect(listWorkOrderPhotos("wo-1", CONFIG, unauthorized.impl)).rejects.toThrow(
      "Not authorized",
    );
    const broken = fetchStub(() => Promise.resolve(new Response("boom", { status: 500 })));
    expect(listWorkOrderPhotos("wo-1", CONFIG, broken.impl)).rejects.toThrow("(500)");
  });
});
