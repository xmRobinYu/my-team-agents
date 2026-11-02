/**
 * A textarea whose value AND selection are owned by React (I8 / AC9.3).
 *
 * The hazard this removes: React re-renders a controlled textarea and the caret
 * jumps to the end, so a mention inserted mid-sentence silently becomes a
 * mention appended to the draft. Setting `selectionStart`/`selectionEnd` inside
 * `useLayoutEffect` (before paint, after the value commit) is what keeps the
 * caret where the splice says it belongs — and makes the next `@` detection read
 * the real caret instead of a stale one.
 */

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { InsertResult } from "./mentions";

export interface ManagedTextarea {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  setValue: (next: string) => void;
  caret: number;
  setCaret: (next: number) => void;
  /** Apply a splice result: new text, then restore the caret it computed. */
  applyInsert: (result: InsertResult) => void;
  /** Focus the field and put the caret at `position`. */
  focusAt: (position: number) => void;
  onChangeFromDom: (event: { target: HTMLTextAreaElement }) => void;
}

export function useManagedTextarea(initial = ""): ManagedTextarea {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [value, setValue] = useState(initial);
  const [caret, setCaretState] = useState(initial.length);
  /** The caret to restore on the next commit; null when nothing is pending. */
  const pendingCaret = useRef<number | null>(null);

  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    const wanted = pendingCaret.current;
    if (wanted === null) return;
    pendingCaret.current = null;
    const clamped = Math.max(0, Math.min(wanted, node.value.length));
    node.focus({ preventScroll: true });
    // setSelectionRange before reading back: some engines ignore a range set on
    // a node that has never been focused, and the caret must not lag a render.
    node.setSelectionRange(clamped, clamped);
    setCaretState(clamped);
  }, [value]);

  const applyInsert = useCallback((result: InsertResult) => {
    pendingCaret.current = result.caret;
    setValue(result.text);
    setCaretState(result.caret);
  }, []);

  const focusAt = useCallback((position: number) => {
    pendingCaret.current = position;
    const node = textareaRef.current;
    if (node) {
      node.focus({ preventScroll: true });
      const clamped = Math.max(0, Math.min(position, node.value.length));
      node.setSelectionRange(clamped, clamped);
      setCaretState(clamped);
      pendingCaret.current = null;
    }
  }, []);

  const onChangeFromDom = useCallback((event: { target: HTMLTextAreaElement }) => {
    setValue(event.target.value);
    setCaretState(event.target.selectionStart ?? event.target.value.length);
  }, []);

  const setCaret = useCallback((next: number) => {
    setCaretState(next);
    const node = textareaRef.current;
    if (node) {
      const clamped = Math.max(0, Math.min(next, node.value.length));
      node.setSelectionRange(clamped, clamped);
    }
  }, []);

  return { textareaRef, value, setValue, caret, setCaret, applyInsert, focusAt, onChangeFromDom };
}
