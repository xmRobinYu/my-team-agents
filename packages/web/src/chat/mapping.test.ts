import { describe, expect, it } from "vitest";
import type { TaskEventRow, TaskRecord } from "../api/types";
import {
  ASSISTANT_MESSAGE_ID_PREFIX,
  mergeText,
  taskTranscriptFromEvents,
  transcriptCursor,
  transcriptIsRunning,
  USER_MESSAGE_ID_PREFIX,
} from "./mapping";

const baseTask = (over: Partial<TaskRecord> = {}): TaskRecord => ({
  id: "task-1",
  chainId: "chain-1",
  tenantId: "default",
  projectId: "default",
  memberId: "mock-agent",
  workspacePath: "/work",
  prompt: "原始需求",
  status: "succeeded",
  depth: 0,
  batch: 1,
  batchAttempts: 1,
  fencingToken: 1,
  activeAttemptId: null,
  availableAt: 0,
  result: null,
  error: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_001_000,
  ...over,
});

const row = (
  id: number,
  attemptId: string,
  sequence: number,
  type: string,
  text?: string,
): TaskEventRow => ({
  id,
  attemptId,
  sequence,
  event: {
    type,
    runId: attemptId,
    timestamp: new Date(1_700_000_000_000 + id * 1000).toISOString(),
    ...(text === undefined ? {} : { text }),
  },
});

const transcript = (task: TaskRecord, rows: TaskEventRow[]) =>
  taskTranscriptFromEvents(
    { id: task.id, prompt: task.prompt, createdAt: task.createdAt, status: task.status },
    rows,
  );

describe("mergeText", () => {
  it("最终文本以 message_end 为准", () => {
    expect(mergeText("你好", "你好，世界", true)).toBe("你好，世界");
  });

  it("累积式更新直接替换，不重复拼接", () => {
    expect(mergeText("你好", "你好，世界", false)).toBe("你好，世界");
  });

  it("增量式更新按序拼接", () => {
    expect(mergeText("你好", "，世界", false)).toBe("你好，世界");
  });
});

describe("taskTranscriptFromEvents", () => {
  it("原始 prompt 收敛为唯一的用户消息", () => {
    const result = transcript(baseTask(), []);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      id: `${USER_MESSAGE_ID_PREFIX}task-1`,
      role: "user",
      text: "原始需求",
      status: "complete",
    });
  });

  it("同一 Attempt 的 message_update/message_end 收敛为一条助手消息", () => {
    const result = transcript(baseTask(), [
      row(1, "a1", 1, "message_update", "你"),
      row(2, "a1", 2, "message_update", "你好"),
      row(3, "a1", 3, "message_end", "你好，世界"),
    ]);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[1]).toMatchObject({
      id: `${ASSISTANT_MESSAGE_ID_PREFIX}a1`,
      role: "assistant",
      text: "你好，世界",
      status: "complete",
      sourceEventId: 3,
    });
    expect(result.settledAttempts).toBe(1);
  });

  it("多个 Attempt 各产出独立助手消息，而不是多个线程", () => {
    const result = transcript(baseTask(), [
      row(1, "a1", 1, "message_end", "第一次回答"),
      row(2, "a2", 1, "message_end", "第二次回答"),
    ]);
    expect(result.entries.map((entry) => entry.text)).toEqual([
      "原始需求",
      "第一次回答",
      "第二次回答",
    ]);
    expect(new Set(result.entries.map((entry) => entry.id)).size).toBe(3);
  });

  it("纯工具调用的 Attempt 不产生空消息", () => {
    const result = transcript(baseTask(), [
      row(1, "a1", 1, "tool_execution_start"),
      row(2, "a1", 2, "tool_execution_end"),
    ]);
    expect(result.entries).toHaveLength(1);
    expect(result.pendingAttempts).toBe(0);
  });

  it("运行中的 Attempt 尚无文本时给出 running 占位", () => {
    const result = transcript(baseTask({ status: "running" }), [row(1, "a1", 1, "agent_start")]);
    expect(result.entries.at(-1)).toMatchObject({
      id: `${ASSISTANT_MESSAGE_ID_PREFIX}a1`,
      role: "assistant",
      status: "running",
    });
    expect(result.pendingAttempts).toBe(1);
  });

  it("同一 Attempt 从 running 收束为 complete 时保持消息 id 不变", () => {
    const running = transcript(baseTask({ status: "running" }), [row(1, "a1", 1, "agent_start")]);
    const settled = transcript(baseTask({ status: "succeeded" }), [
      row(1, "a1", 1, "agent_start"),
      row(2, "a1", 2, "message_end", "回答"),
    ]);
    expect(running.entries.at(-1)?.id).toBe(settled.entries.at(-1)?.id);
    expect(settled.entries.at(-1)?.status).toBe("complete");
  });

  it("排队但还没有事件的任务也显示运行中占位", () => {
    const result = transcript(baseTask({ status: "queued" }), []);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[1]).toMatchObject({
      id: `${ASSISTANT_MESSAGE_ID_PREFIX}pending`,
      status: "running",
    });
  });

  it("失败任务里未收尾的 Attempt 标记为 incomplete/error", () => {
    const result = transcript(baseTask({ status: "failed" }), [
      row(1, "a1", 1, "message_update", "半成品"),
    ]);
    expect(result.entries[1]).toMatchObject({ status: "incomplete", reason: "error" });
  });

  it("已收束（message_end）的文本在任务失败后仍为 complete", () => {
    const result = transcript(baseTask({ status: "failed" }), [
      row(1, "a1", 1, "message_end", "完整回答"),
    ]);
    expect(result.entries[1]?.status).toBe("complete");
  });

  it("助手消息按首个事件顺序排列，与到达顺序无关", () => {
    const result = transcript(baseTask(), [
      row(5, "a2", 1, "message_end", "后发"),
      row(2, "a1", 1, "message_end", "先发"),
    ]);
    expect(result.entries.map((entry) => entry.text)).toEqual(["原始需求", "先发", "后发"]);
  });
});

describe("transcript 游标与运行态", () => {
  it("transcriptCursor 取最大事件行 id，空流回退", () => {
    expect(transcriptCursor([row(3, "a1", 1, "message_end"), row(7, "a1", 2, "agent_end")])).toBe(7);
    expect(transcriptCursor([], 4)).toBe(4);
  });

  it("transcriptIsRunning 只在推进中的状态为真", () => {
    for (const status of ["queued", "running", "retry_wait", "cancelling"] as const) {
      expect(transcriptIsRunning(status)).toBe(true);
    }
    for (const status of ["succeeded", "failed", "cancelled", "blocked"] as const) {
      expect(transcriptIsRunning(status)).toBe(false);
    }
    expect(transcriptIsRunning(null)).toBe(false);
  });
});
