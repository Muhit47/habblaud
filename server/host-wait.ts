// Long-polling for host helper rounds (scripts/codex-bridge.ts): instead of polling every 500ms, it
// requests with `?wait=1` and the response pauses here until work arrives (or up to HOST_WAIT_MS). While waiting,
// helper counts as present.

/** How long a round pauses waiting for work (helper re-polls immediately after). */
export const HOST_WAIT_MS = 20_000;

export class HostWait {
  private readonly waiters = new Set<() => void>();
  private seenAt = -Infinity;

  constructor(
    private readonly presenceMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Helper is currently waiting or was active less than `presenceMs` ago. */
  present(): boolean {
    return this.waiters.size > 0 || this.now() - this.seenAt <= this.presenceMs;
  }

  seen(): void {
    this.seenAt = this.now();
  }

  /** Work arrived: releases waiting pollers. */
  wake(): void {
    const list = [...this.waiters];
    this.waiters.clear();
    for (const done of list) done();
  }

  /** Waits for wake(), `ms`, or `signal` (helper connection dropped). */
  wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || ms <= 0) return Promise.resolve();
    return new Promise((ok) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        this.waiters.delete(done);
        this.seen();
        ok();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      signal?.addEventListener('abort', done, { once: true });
      this.waiters.add(done);
    });
  }
}

/**
 * Waiting round: returns whatever `take` has immediately; if empty, waits for work and retries. If connection
 * drops midway, returns empty without popping from queue.
 */
export async function pollWithWait<T>(wait: HostWait, take: () => T[], ms: number, signal?: AbortSignal): Promise<T[]> {
  wait.seen();
  const now = take();
  if (now.length || ms <= 0) return now;
  await wait.wait(ms, signal);
  return signal?.aborted ? [] : take();
}
