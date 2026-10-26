/**
 * Stall watchdog.
 *
 * A run that produces no events forever holds a slot and blocks the queue.
 * teamagentx models this with a stall watchdog; here the rule is explicit:
 * if no event arrives within `timeoutMs`, the run is cancelled via
 * `handle.cancel()`. Any observed event resets the timer.
 *
 * Cancel is cooperative: it is a signal to the runtime, not a guarantee.
 */

import type { RunHandle } from "@my-team-agents/runtime-core";

export interface StallWatchdogOptions {
  timeoutMs: number;
  /** Injectable clock for tests. */
  now?: () => number;
  onStall?: (info: { idleMs: number }) => void;
}

export class StallWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastEventAt: number;
  private stopped = false;

  constructor(
    private readonly handle: RunHandle,
    private readonly options: StallWatchdogOptions,
  ) {
    this.lastEventAt = (options.now ?? Date.now)();
  }

  /** Start watching. Safe to call once per run. */
  start(): void {
    if (this.stopped) return;
    this.arm();
  }

  /** Call on every observed event to reset the idle window. */
  ping(): void {
    if (this.stopped) return;
    this.lastEventAt = (this.options.now ?? Date.now)();
    this.arm();
  }

  /** Stop watching; a settled run must not be cancelled retroactively. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const now = (this.options.now ?? Date.now)();
      const idleMs = now - this.lastEventAt;
      this.options.onStall?.({ idleMs });
      void this.handle.cancel();
    }, this.options.timeoutMs);
    // Do not hold the process open just for a watchdog.
    this.timer.unref?.();
  }
}
