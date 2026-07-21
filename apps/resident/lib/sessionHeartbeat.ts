export type HeartbeatStatus = 'valid' | 'invalid' | 'unknown';

export interface HeartbeatResult {
  status: HeartbeatStatus;
  nextCheckAfter?: string | null;
  reason?: string;
}

export function classifyHeartbeatFailure(status?: number): HeartbeatStatus {
  return status === 401 || status === 403 ? 'invalid' : 'unknown';
}

export function shouldLogoutForHeartbeatResult(result: HeartbeatStatus | HeartbeatResult): boolean {
  return (typeof result === 'string' ? result : result.status) === 'invalid';
}

export function shouldRunHeartbeat(nextCheckAfter: string | null | undefined, now = Date.now()): boolean {
  if (!nextCheckAfter) return true;

  const nextCheckAt = Date.parse(nextCheckAfter);
  if (!Number.isFinite(nextCheckAt)) return true;

  return now >= nextCheckAt;
}
