import { createAdminClient, getMissingSupabaseAdminEnvVars } from "./supabase/admin";

type RateLimitEntry = { count: number; resetAt: number };
type RateLimitInput = {
  bucket: string;
  maxAttempts: number;
  windowMs: number;
  failClosed?: boolean;
  now?: number;
};

const memoryAttempts = new Map<string, RateLimitEntry>();

export async function checkMemoryRateLimit(
  bucket: string,
  maxAttempts: number,
  windowMs: number,
  now = Date.now()
): Promise<boolean> {
  const existing = memoryAttempts.get(bucket);
  if (!existing || now > existing.resetAt) {
    memoryAttempts.set(bucket, { count: 1, resetAt: now + windowMs });
    return true;
  }

  existing.count += 1;
  return existing.count <= maxAttempts;
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
