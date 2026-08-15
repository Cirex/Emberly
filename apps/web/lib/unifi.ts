/**
 * UniFi Site Manager client (api.ui.com). The cloud API key lives server-side
 * (UNIFI_API_KEY) and must be minted by the console OWNER account — invited
 * admins get "user is not the owner of this host" on the Protect endpoints.
 * The property runs Protect on two consoles (UDM Pro at the gate, UNVR Pro in
 * the office), so every camera reference carries its console id.
 */

const API_BASE = "https://api.ui.com";

export function unifiConfigured(): boolean {
  return Boolean(process.env.UNIFI_API_KEY?.trim());
}

function apiKey(): string {
  const key = process.env.UNIFI_API_KEY?.trim();
  if (!key) throw new Error("UNIFI_API_KEY is not set");
  return key;
}

export interface UnifiCamera {
  id: string;
  name: string;
  state: string;
}

export interface UnifiConsole {
  consoleId: string;
  consoleName: string;
  cameras: UnifiCamera[];
}

function protectUrl(consoleId: string, path: string): string {
  return (
    `${API_BASE}/v1/connector/consoles/${encodeURIComponent(consoleId)}` +
    `/protect/integration/v1${path}`
  );
}

/**
 * UniFi's cloud API sits behind the property's uplink and occasionally just
 * stops answering. Without a deadline the request hangs for Node's default
 * (effectively forever), pinning the whole request context — and the guard
 * iPads re-issue snapshot requests on an 8s tick, so hung calls stack up.
 */
const REQUEST_TIMEOUT_MS = 10_000;

async function unifiFetch(url: string): Promise<Response> {
  return fetch(url, {
    headers: { "X-API-Key": apiKey() },
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/**
 * Release a response whose body we are not going to read.
 *
 * An unconsumed body keeps its buffered chunks and holds the underlying
 * connection out of the keep-alive pool until GC gets around to it. Every
 * early return below is on the error path, which is exactly when the property
 * is generating the most of them.
 */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

/**
 * Every console the key's account owns, with its Protect cameras. Consoles
 * without Protect (or that error) are skipped rather than failing the sweep.
 */
export async function listUnifiCameras(): Promise<UnifiConsole[]> {
  const res = await unifiFetch(`${API_BASE}/v1/hosts`);
  if (!res.ok) {
    await discard(res);
    throw new Error(`UniFi hosts request failed (${res.status})`);
  }
  const payload = (await res.json()) as {
    data?: Array<{ id?: string; type?: string; reportedState?: { name?: string; hostname?: string } }>;
  };
  const consoles = (payload.data ?? []).filter((h) => h.type === "console" && h.id);

  const results = await Promise.all(
    consoles.map(async (host): Promise<UnifiConsole | null> => {
      try {
        const camsRes = await unifiFetch(protectUrl(host.id as string, "/cameras"));
        if (!camsRes.ok) {
          await discard(camsRes);
          return null;
        }
        const cams = (await camsRes.json()) as Array<{ id?: string; name?: string; state?: string }>;
        if (!Array.isArray(cams)) return null;
        return {
          consoleId: host.id as string,
          consoleName: (host.reportedState?.name ?? host.reportedState?.hostname ?? "Console").trim(),
          cameras: cams
            .filter((c) => c.id)
            .map((c) => ({ id: c.id as string, name: c.name ?? "Camera", state: c.state ?? "UNKNOWN" })),
        };
      } catch {
        return null;
      }
    }),
  );
  return results.filter((c): c is UnifiConsole => c !== null && c.cameras.length > 0);
}

/**
 * The camera's Protect name, resolved at pairing time and stored as the
 * marker's label. Null when UniFi can't answer (pairing then fails loudly
 * rather than saving a nameless camera).
 */
export async function fetchUnifiCameraName(consoleId: string, cameraId: string): Promise<string | null> {
  try {
    const res = await unifiFetch(protectUrl(consoleId, `/cameras/${encodeURIComponent(cameraId)}`));
    if (!res.ok) {
      await discard(res);
      return null;
    }
    const cam = (await res.json()) as { name?: string };
    return cam.name?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Refresh stored camera names against UniFi so a camera renamed in Protect
 * eventually shows up on the map. Throttled: only calls UniFi when a paired
 * camera's name hasn't been reconciled within NAME_TTL_MS (or when caller
 * passes already-fetched consoles / forces it). Best-effort — a UniFi outage
 * leaves the last-known names in place. Returns the number of rows renamed.
 */
const NAME_TTL_MS = 10 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function reconcileCameraNames(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  opts?: { consoles?: UnifiConsole[]; force?: boolean },
): Promise<number> {
  if (!unifiConfigured()) return 0;
  try {
    const { data } = await client
      .from("map_cameras")
      .select("id, unifi_console_id, unifi_camera_id, unifi_camera_name, unifi_camera_name_synced_at")
      .not("unifi_camera_id", "is", null);
    const rows = (data ?? []) as Array<{
      id: string;
      unifi_console_id: string | null;
      unifi_camera_id: string | null;
      unifi_camera_name: string | null;
      unifi_camera_name_synced_at: string | null;
    }>;
    if (rows.length === 0) return 0;

    const now = Date.now();
    const stale =
      opts?.force ||
      Boolean(opts?.consoles) ||
      rows.some(
        (r) =>
          !r.unifi_camera_name_synced_at || now - Date.parse(r.unifi_camera_name_synced_at) > NAME_TTL_MS,
      );
    if (!stale) return 0;

    const consoles = opts?.consoles ?? (await listUnifiCameras());
    const nameByKey = new Map<string, string>();
    for (const con of consoles) {
      for (const cam of con.cameras) nameByKey.set(`${con.consoleId}|${cam.id}`, cam.name);
    }

    const nowIso = new Date().toISOString();
    let renamed = 0;
    await Promise.all(
      rows.map(async (r) => {
        const name = nameByKey.get(`${r.unifi_console_id}|${r.unifi_camera_id}`);
        // Camera missing from the live list (offline/removed) → leave its name,
        // but still stamp so we don't re-hit UniFi for it every request.
        const patch: Record<string, unknown> = { unifi_camera_name_synced_at: nowIso };
        if (name && name !== r.unifi_camera_name) {
          patch.unifi_camera_name = name;
          renamed += 1;
        }
        await client.from("map_cameras").update(patch).eq("id", r.id);
      }),
    );
    return renamed;
  } catch (error) {
    console.error("[unifi] reconcileCameraNames failed:", error);
    return 0;
  }
}

/** JPEG snapshot bytes for one camera, or null when UniFi can't serve one. */
export async function fetchUnifiSnapshot(
  consoleId: string,
  cameraId: string,
): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  const res = await unifiFetch(
    protectUrl(consoleId, `/cameras/${encodeURIComponent(cameraId)}/snapshot`),
  );
  if (!res.ok) {
    await discard(res);
    return null;
  }
  return {
    body: await res.arrayBuffer(),
    contentType: res.headers.get("content-type") ?? "image/jpeg",
  };
}
