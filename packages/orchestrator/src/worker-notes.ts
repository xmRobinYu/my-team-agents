/**
 * The named refusals a dispatch batch produces.
 *
 * Split out of `durable-worker.ts` for the same line-budget reason as
 * `worker-result.ts`. Kept together with its own label rules so a refusal message
 * and the label the stream shows for it cannot drift apart.
 */

/** One recorded refusal: the `【…】` label the stream shows, plus the text behind it. */
export interface ResolutionNote {
  label: "提及解析" | "交接校验";
  body: string;
}

/** One resolved dispatch target. `agent` is null when there is no roster to read. */

/**
 * D5: a `handoff_to` target that is not in the roster, or that two members answer
 * to. Both are refusals the operator must be able to tell apart from a prose
 * 提及解析 refusal, which is why the label is part of the value and not a prefix
 * someone remembers to add.
 */
  export function handoffResolutionNotes(unknown: string[], ambiguous: string[]): ResolutionNote[] {
    const notes: ResolutionNote[] = [];
    if (unknown.length > 0) {
      notes.push({
        label: "交接校验",
        body: `handoff_to 的目标不是本群成员：${unknown.join(" / ")}，未派发`,
      });
    }
    if (ambiguous.length > 0) {
      notes.push({
        label: "交接校验",
        body: `handoff_to 的目标在本群有重名成员，无法确定 ${ambiguous.join(" / ")} 指谁，未派发`,
      });
    }
    return notes;
  }
