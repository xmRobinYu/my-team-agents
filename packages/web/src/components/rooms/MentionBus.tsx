/**
 * The one mention-insertion path (AC9.3 → AC9.4).
 *
 * The member panel lives in column 3, the composer in column 2, and both sit
 * under the same runtime provider. A context — rather than prop-drilling a ref
 * through the layout — is what lets a click on a member call *exactly* the same
 * function a keyboard pick does, so the two cannot drift into different
 * insertion rules.
 *
 * When no room is on screen the handle is null and the function is a no-op: a
 * member click in the empty state must not pretend something happened.
 */

import { createContext, useCallback, useContext } from "react";
import type { ReactNode, RefObject } from "react";
import type { RoomAgent } from "../../rooms/types";
import type { ComposerHandle } from "./RoomComposer";

const MentionContext = createContext<((agent: RoomAgent) => void) | null>(null);

/** The composer's insertion function, or a no-op when no group is mounted. */
export function useRoomMention(): (agent: RoomAgent) => void {
  return useContext(MentionContext) ?? (() => undefined);
}

export function MentionProvider({
  handle,
  children,
}: {
  handle: RefObject<ComposerHandle | null>;
  children: ReactNode;
}) {
  const insert = useCallback(
    (agent: RoomAgent) => {
      handle.current?.insertMember(agent);
    },
    [handle],
  );
  return <MentionContext.Provider value={insert}>{children}</MentionContext.Provider>;
}
