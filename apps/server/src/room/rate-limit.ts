/** Sliding one-second window: at most `limit` accepted calls in any `windowMs` span. */
export class RateLimiter {
  private readonly accepted: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs = 1000,
    private readonly now: () => number = () => performance.now(),
  ) {}

  allow(): boolean {
    const now = this.now();
    while (this.accepted.length > 0 && (this.accepted[0] ?? now) <= now - this.windowMs) {
      this.accepted.shift();
    }
    if (this.accepted.length >= this.limit) return false;
    this.accepted.push(now);
    return true;
  }
}

/** Per-connection limits from protocol.md. */
export const RATE_LIMITS = { move: 10, ephemeral: 20, chat: 1 } as const;
export type LimitedMessage = keyof typeof RATE_LIMITS;
