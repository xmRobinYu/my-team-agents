/**
 * The group composer (AC9.3 + the pre-send rules the trigger demands).
 *
 * Send path: `POST /api/rooms/:id/messages` — never the Pi composer, because a
 * room's user turn is a mention trigger that writes Tasks inside one server
 * transaction (Q27/Q29: the UI is not the authority).
 *
 * Three refusals, all raised BEFORE the request goes out, because the backend
 * answers each of them with a 4xx that rolls the whole message back:
 *   1. `@` typed but nobody picked — the draft still has an unresolved mention;
 *   2. a name no member has (hand-edited, or half-deleted after picking);
 *   3. a duplicated member name, which the picker also refuses to select.
 * The check is a browser twin of `resolveMentions` (`rooms/mentions.ts`), so UI
 * and server agree about what a valid mention is. If they ever diverge, the
 * server still wins: its 4xx is surfaced verbatim and the draft is kept, because
 * a failed send must never eat what the user typed.
 *
 * A guard block (`blocked[]` inside a 201 body) is NOT an error and is not
 * rendered as one (Q40): the user message and the explanatory system message are
 * already committed, so the composer only counts them and the stream shows them.
 *
 * Focus model: the textarea never loses focus while the popover is open, so the
 * popover's keys arrive through the textarea's own `onKeyDown` and are routed
 * here; `aria-activedescendant` tells assistive tech which option is live.
 *
 * The insertion handle (`ComposerHandle.insertMember`) is the ONE mention-insert
 * path: the member panel (AC9.4) calls the same function the picker does, so a
 * click on a member and a keyboard pick cannot drift apart.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { postRoomTurn, RoomApiError } from "../../rooms/api";
import {
  duplicateNameCounts,
  filterMentionCandidates,
  findMentionTrigger,
  insertMentionAtCaret,
  insertMentionAtTrigger,
  resolveRoomMentions,
  validateRoomDraft,
} from "../../rooms/mentions";
import type { MentionTrigger } from "../../rooms/mentions";
import type { RoomAgent } from "../../rooms/types";
import type { RoomSendResult } from "../../rooms/api";
import { useManagedTextarea } from "../../rooms/useManagedTextarea";
import { MentionPicker, optionId } from "./MentionPicker";

export interface ComposerHandle {
  /** Insert `@name` at the caret (or into the live mention token). */
  insertMember: (agent: RoomAgent) => void;
  /** The current draft text and caret, for diagnostics and tests. */
  inspect: () => { text: string; caret: number };
  focus: () => void;
}

export interface RoomComposerProps {
  roomId: string | null;
  agents: readonly RoomAgent[];
  /** Called with the server's own 201 body: the committed row, the Tasks it
   * queued, the guard blocks, and (I7) the thread snapshot right after the
   * commit. The caller echoes that row — re-posting would create a SECOND
   * message and a second round of Tasks. */
  onCommitted: (result: RoomSendResult) => void;
  disabled?: boolean;
  disabledReason?: string;
  draftKey?: string;
}

export const RoomComposer = forwardRef<ComposerHandle, RoomComposerProps>(function RoomComposer(
  { roomId, agents, onCommitted, disabled = false, disabledReason, draftKey = "" },
  ref,
) {
  const draft = useManagedTextarea("");
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "warn" | "danger" | "info"; text: string } | null>(null);
  const busyRef = useRef(false);

  const trigger = useMemo(
    () => (disabled ? null : findMentionTrigger(draft.value, draft.caret)),
    [disabled, draft.value, draft.caret],
  );
  const triggerKey = trigger ? `${trigger.start}:${draft.value}` : null;
  const pickerOpen = trigger !== null && dismissedKey !== triggerKey;

  const candidates = useMemo(
    () => (pickerOpen && trigger ? filterMentionCandidates(agents, trigger.query) : []),
    [pickerOpen, trigger, agents],
  );
  const duplicates = useMemo(() => duplicateNameCounts(agents), [agents]);

  useEffect(() => {
    setHighlight((current) => (candidates.length === 0 ? 0 : Math.min(current, candidates.length - 1)));
  }, [candidates.length]);

  // Switching rooms must not carry an unrelated draft into the new one.
  useEffect(() => {
    draft.setValue("");
    setFeedback(null);
    setDismissedKey(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on room/draft-key change only
  }, [draftKey, roomId]);

  const targets = useMemo(() => resolveRoomMentions(draft.value, agents).targets, [draft.value, agents]);

  const commit = useCallback(
    async (content: string) => {
      if (!roomId || busyRef.current) return;
      busyRef.current = true;
      setSending(true);
      setFeedback(null);
      try {
        const result = await postRoomTurn(roomId, content);
        setDismissedKey(null);
        onCommitted(result);
        setFeedback(
          result.blocked.length > 0
            ? {
                tone: "info",
                text: `消息已记录；平台拦下了 ${result.blocked.length} 个触发，原因见流中的系统提示（这不是发送失败）。`,
              }
            : { tone: "info", text: `已触发 ${result.tasks.length} 个 agent，等待回复。` },
        );
      } catch (error: unknown) {
        const message =
          error instanceof RoomApiError
            ? `后端拒绝 [${error.code ?? error.status}]：${error.message}` +
              (error.names.length > 0 ? `（${error.names.map((name) => `@${name}`).join(" / ")}）` : "") +
              (error.hint ? ` · ${error.hint}` : "")
            : `发送失败：${error instanceof Error ? error.message : String(error)}`;
        setFeedback({ tone: "danger", text: message });
      } finally {
        busyRef.current = false;
        setSending(false);
      }
    },
    [draft, onCommitted, roomId],
  );

  const handleSend = useCallback(() => {
    if (!roomId || busyRef.current) return;
    const validation = validateRoomDraft(draft.value, agents);
    if (!validation.ok) {
      setFeedback({ tone: "warn", text: validation.message ?? "这条消息不会被任何 agent 处理" });
      return;
    }
    void commit(draft.value);
  }, [agents, commit, draft.value, roomId]);

  /** THE insertion path — picker, member panel and keyboard all land here. */
  const insertWith = useCallback(
    (agent: RoomAgent, active: MentionTrigger | null) => {
      draft.applyInsert(
        active
          ? insertMentionAtTrigger(draft.value, active, agent.name)
          : insertMentionAtCaret(draft.value, draft.caret, agent.name),
      );
      setDismissedKey(null);
      setFeedback(null);
    },
    [draft],
  );

  const insertMember = useCallback(
    (agent: RoomAgent) => {
      insertWith(agent, findMentionTrigger(draft.value, draft.caret));
    },
    [draft, insertWith],
  );

  useImperativeHandle(
    ref,
    () => ({
      insertMember,
      inspect: () => ({ text: draft.value, caret: draft.caret }),
      focus: () => draft.focusAt(draft.caret),
    }),
    [draft, insertMember],
  );

  const accept = useCallback(() => {
    const agent = candidates[highlight];
    if (!agent) return;
    if ((duplicates.get(agent.name) ?? 1) > 1) return;
    insertWith(agent, trigger);
  }, [candidates, duplicates, highlight, insertWith, trigger]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (pickerOpen) {
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setHighlight((current) => (current + 1) % Math.max(1, candidates.length));
          return;
        case "ArrowUp":
          event.preventDefault();
          setHighlight((current) => (current - 1 + candidates.length) % Math.max(1, candidates.length));
          return;
        case "Enter":
          if (event.nativeEvent.isComposing) return; // a CJK IME's Enter commits text
          event.preventDefault();
          accept();
          return;
        case "Tab":
          if (candidates.length === 0) return;
          event.preventDefault();
          accept();
          return;
        case "Escape":
          event.preventDefault();
          setDismissedKey(triggerKey);
          return;
        default:
          return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      handleSend();
    }
  };

  const preview = targets.map((agent) => agent.name);

  return (
    <div className="room-composer" data-testid="room-composer">
      {pickerOpen ? (
        <MentionPicker
          candidates={candidates}
          highlight={highlight}
          duplicates={duplicates}
          query={trigger?.query ?? ""}
          onHover={setHighlight}
          onPick={(agent) => insertWith(agent, trigger)}
        />
      ) : null}

      <textarea
        ref={draft.textareaRef}
        className="composer-input room-composer-input"
        placeholder={disabled ? (disabledReason ?? "暂不可用") : "@ 一个成员开始讨论（Enter 发送，Shift+Enter 换行）"}
        value={draft.value}
        onChange={draft.onChangeFromDom}
        onKeyDown={onKeyDown}
        onClick={(event) => draft.setCaret(event.currentTarget.selectionStart ?? 0)}
        onKeyUp={(event) => draft.setCaret(event.currentTarget.selectionStart ?? 0)}
        onSelect={(event) => draft.setCaret(event.currentTarget.selectionStart ?? 0)}
        disabled={disabled}
        rows={3}
        aria-label="群消息输入框"
        aria-expanded={pickerOpen}
        aria-haspopup="listbox"
        aria-controls={pickerOpen ? "mention-popover" : undefined}
        aria-activedescendant={pickerOpen && candidates.length > 0 ? optionId(highlight) : undefined}
        data-testid="room-composer-input"
      />

      <div className="room-composer-row">
        <span className="composer-hint" data-testid="mention-targets">
          {disabled
            ? (disabledReason ?? "")
            : preview.length > 0
              ? `将触发：${preview.map((name) => `@${name}`).join(" ")}`
              : draft.value.trim() === ""
                ? "输入 @ 唤起成员列表（也可点右侧成员）"
                : "尚无有效提及：群里只处理 @ 触发的消息"}
        </span>
        <span className="room-composer-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSend}
            disabled={disabled || sending || draft.value.trim() === ""}
            data-testid="room-composer-send"
          >
            {sending ? "发送中…" : "发送"}
          </button>
        </span>
      </div>

      {feedback ? (
        <p
          className={`room-composer-feedback room-composer-${feedback.tone}`}
          role={feedback.tone === "danger" ? "alert" : "status"}
          data-testid="composer-feedback"
        >
          {feedback.text}
        </p>
      ) : null}
    </div>
  );
});
