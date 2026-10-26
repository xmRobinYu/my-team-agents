import { describe, expect, it, vi } from "vitest";
import { StallWatchdog } from "./stall-watchdog.js";
import type { RunHandle } from "@my-team-agents/runtime-core";

const handle = (): RunHandle & { cancel: ReturnType<typeof vi.fn> } => ({
  runId: "r1",
  events: { [Symbol.asyncIterator]: () => ({ async next() { return { value: undefined, done: true }; } }) },
  cancel: vi.fn(async () => {}),
  settled: Promise.resolve({ runId: "r1", status: "completed" as const }),
});

describe("StallWatchdog", () => {
  it("cancels the run when no event arrives within the timeout", () => {
    vi.useFakeTimers();
    const h = handle();
    const wd = new StallWatchdog(h, { timeoutMs: 1000 });
    wd.start();
    vi.advanceTimersByTime(1001);
    expect(h.cancel).toHaveBeenCalledTimes(1);
    wd.stop();
    vi.useRealTimers();
  });

  it("does NOT cancel while events keep arriving", () => {
    vi.useFakeTimers();
    const h = handle();
    const wd = new StallWatchdog(h, { timeoutMs: 1000 });
    wd.start();
    vi.advanceTimersByTime(900);
    wd.ping(); // resets the idle window
    vi.advanceTimersByTime(900);
    expect(h.cancel).not.toHaveBeenCalled();
    wd.stop();
    vi.useRealTimers();
  });

  it("cancels after the window elapses following the last ping", () => {
    vi.useFakeTimers();
    const h = handle();
    const wd = new StallWatchdog(h, { timeoutMs: 1000 });
    wd.start();
    vi.advanceTimersByTime(900);
    wd.ping();
    vi.advanceTimersByTime(1001);
    expect(h.cancel).toHaveBeenCalledTimes(1);
    wd.stop();
    vi.useRealTimers();
  });

  it("reports idle time to onStall", () => {
    vi.useFakeTimers();
    const h = handle();
    const onStall = vi.fn();
    const wd = new StallWatchdog(h, { timeoutMs: 1000, onStall });
    wd.start();
    vi.advanceTimersByTime(1000);
    expect(onStall).toHaveBeenCalledWith({ idleMs: 1000 });
    wd.stop();
    vi.useRealTimers();
  });

  // A settled run must never be cancelled retroactively.
  it("does not cancel after stop()", () => {
    vi.useFakeTimers();
    const h = handle();
    const wd = new StallWatchdog(h, { timeoutMs: 1000 });
    wd.start();
    wd.stop();
    vi.advanceTimersByTime(5000);
    expect(h.cancel).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("ignores pings after stop()", () => {
    vi.useFakeTimers();
    const h = handle();
    const wd = new StallWatchdog(h, { timeoutMs: 1000 });
    wd.start();
    wd.stop();
    wd.ping();
    vi.advanceTimersByTime(5000);
    expect(h.cancel).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
