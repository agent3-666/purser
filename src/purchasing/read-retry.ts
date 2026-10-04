/** Local policy for anonymous, idempotent GET requests. Not a provider availability guarantee. */
export const readPolicy = { maxAttempts: 2, attemptTimeoutMs: 12_000, totalTimeoutMs: 25_000,
  retryDelayMs: 250, maxRetryAfterMs: 2_000 };
export type ReadPolicy = typeof readPolicy;
export function validateReadPolicy(p: ReadPolicy): void {
  if (Object.values(p).some((value) => !Number.isSafeInteger(value) || value < 0) ||
      p.maxAttempts < 1 || p.maxAttempts > 3 || p.attemptTimeoutMs < 1 ||
      p.totalTimeoutMs < 1 || p.totalTimeoutMs > 60_000 || p.retryDelayMs > 2_000 || p.maxRetryAfterMs > 5_000) {
    throw new Error("invalid read retry policy");
  }
}
/** Retry-After follows HTTP seconds/date syntax; invalid values stop retries, not shorten waits. */
export function parseReadRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return Infinity;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : Infinity;
}
export function decideReadRetry(input: { retryable: boolean; attempt: number; remainingMs: number;
  retryAfterMs?: number }, p: ReadPolicy = readPolicy) {
  if (!input.retryable) return { retry: false, delayMs: 0, stopReason: "non_retryable" };
  if (input.attempt >= p.maxAttempts) return { retry: false, delayMs: 0, stopReason: "attempt_limit" };
  const delayMs = input.retryAfterMs ?? p.retryDelayMs;
  if (!Number.isFinite(delayMs) || delayMs > p.maxRetryAfterMs) return { retry: false, delayMs: 0, stopReason: "retry_after_exceeds_budget" };
  if (input.remainingMs <= delayMs) return { retry: false, delayMs: 0, stopReason: "total_time_limit" };
  return { retry: true, delayMs, stopReason: undefined };
}
