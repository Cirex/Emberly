/**
 * Langbly translation client — a Google Cloud Translation v2-compatible REST
 * API (https://langbly.com). Two calls, both batched:
 *   detect(texts)                    → one BCP-47 code per input
 *   translateBatch(texts, from, to)  → one translated string per input
 *
 * The base URL and key come from the environment so nothing is hard-coded and
 * the endpoint can be pointed at any v2-compatible service (Langbly, Google, a
 * self-hosted proxy) without code changes. Construct via `langblyFromEnv`,
 * which returns null when no key is set — the job then no-ops rather than
 * throwing, so the sync is safe to deploy before the key exists.
 */

export interface Translator {
  detect(texts: string[]): Promise<string[]>;
  translateBatch(texts: string[], from: string, to: string): Promise<string[]>;
}

/** Segments per request. Google v2 caps at 128; stay comfortably under. */
const BATCH = 100;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface LangblyConfig {
  apiKey: string;
  /** e.g. https://api.langbly.com — no trailing path. */
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export class LangblyClient implements Translator {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: LangblyConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async detect(texts: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const group of chunk(texts, BATCH)) {
      const body = await this.post("/language/translate/v2/detect", { q: group });
      const detections = body?.data?.detections;
      if (!Array.isArray(detections) || detections.length !== group.length) {
        // A malformed batch shouldn't poison the rest — mark it undetermined.
        for (let i = 0; i < group.length; i += 1) out.push("und");
        continue;
      }
      for (const d of detections) {
        // v2 returns an array of candidates per input; take the top.
        out.push(Array.isArray(d) && d[0]?.language ? d[0].language : "und");
      }
    }
    return out;
  }

  async translateBatch(texts: string[], from: string, to: string): Promise<string[]> {
    const out: string[] = [];
    for (const group of chunk(texts, BATCH)) {
      const body = await this.post("/language/translate/v2", {
        q: group,
        source: from,
        target: to,
        format: "text",
      });
      const translations = body?.data?.translations;
      if (!Array.isArray(translations) || translations.length !== group.length) {
        throw new Error("Langbly returned an unexpected translation shape");
      }
      for (let i = 0; i < group.length; i += 1) {
        // Fall back to the source rather than dropping a string on a null.
        out.push(translations[i]?.translatedText ?? group[i]);
      }
    }
    return out;
  }

  private async post(path: string, payload: Record<string, unknown>): Promise<any> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}?key=${encodeURIComponent(this.apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Langbly ${path} failed: ${res.status} ${text.slice(0, 200)}`);
    }
    return res.json();
  }
}

/** Build a client from env, or null when no key is configured. */
export function langblyFromEnv(env: NodeJS.ProcessEnv): LangblyClient | null {
  const apiKey = env.LANGBLY_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = env.LANGBLY_API_URL?.trim() || "https://api.langbly.com";
  return new LangblyClient({ apiKey, baseUrl });
}
