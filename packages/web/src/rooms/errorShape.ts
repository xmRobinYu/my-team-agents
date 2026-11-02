/** One error shape for every room read, so "the endpoint is missing" and "the
 * endpoint failed" stay distinguishable in the UI (a 404 is a gap in the server
 * contract, not a breakage, and is reported as such). */

import { RoomApiError } from "./api";

export function describeError(error: unknown): { message: string; missing: boolean } {
  if (error instanceof RoomApiError) return { message: error.message, missing: error.status === 404 };
  return { message: error instanceof Error ? error.message : String(error), missing: false };
}
