import { MemoryRateLimiter } from "./memory-rate-limit";
import { createAdminClient, getMissingSupabaseAdminEnvVars } from "./supabase/admin";

type RateLimitInput = {
  bucket: string;
  maxAttempts: number;
  windowMs: number;
  failClosed?: boolean;
  now?: number;
};

/**
 * Buckets here embed `requestSource(request)` — a client-supplied
 * `x-forwarded-for` — so the key space is caller-controlled and must be
 * bounded. See lib/memory-rate-limit.ts.
 */
const memoryAttempts = new MemoryRateLimiter();

export async function checkMemoryRateLimit(
  bucket: string,
  maxAttempts: number,
  windowMs: number,
  now = Date.now()
): Promise<boolean> {
  return memoryAttempts.check(bucket, maxAttempts, windowMs, now);
}

export function shouldFailClosedOnDurableRateLimitFailure(
  failClosed: boolean | undefined,
  nodeEnv = process.env.NODE_ENV
): boolean {
  return failClosed ?? nodeEnv === "production";
}

export async function checkRateLimit(input: RateLimitInput): Promise<boolean> {
  const now = input.now ?? Date.now();
  if (getMissingSupabaseAdminEnvVars().length > 0) {
    return checkMemoryRateLimit(input.bucket, input.maxAttempts, input.windowMs, now);
  }

  try {
    const { data, error } = await createAdminClient().rpc("check_rate_limit", {
      p_bucket: input.bucket,
      p_max_attempts: input.maxAttempts,
      p_window_seconds: Math.ceil(input.windowMs / 1000),
    });

    if (error) throw error;
    return data === true;
  } catch (error) {
    console.error("[rate-limit] Falling back after durable rate limit failure:", error);
    if (shouldFailClosedOnDurableRateLimitFailure(input.failClosed)) return false;
    return checkMemoryRateLimit(input.bucket, input.maxAttempts, input.windowMs, now);
  }
}
