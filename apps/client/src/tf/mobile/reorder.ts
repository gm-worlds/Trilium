/**
 * Where a dragged row lands, and how to put it back. Pure functions for the phone navigator
 * (`navigator_drag.ts`) and the touch drag of the note tree (`tree_drag.ts`); unit-tested in
 * `reorder.spec.ts`.
 *
 * A finger over the upper or lower quarter of a row aims between rows (an insertion line). Over the
 * middle half of a row that can take children, it aims between rows too until it has rested there
 * for {@link DROP_INSIDE_DELAY_MS}, then it aims inside that row.
 */
import { DROP_INSIDE_DELAY_MS } from "./gestures.js";

export interface RowBox {
    top: number;
    bottom: number;
    /** Whether a drop can put the dragged note inside this row's note. */
    canHoldChildren: boolean;
}

/** `gap` 0 is above the first row, `gap` n below the last. */
export type DropTarget =
    | { kind: "gap"; gap: number }
    | { kind: "inside"; index: number };

export interface Dwell {
    index: number;
    since: number;
}

export interface DropResult {
    target: DropTarget;
    /** The row the finger rests on for a drop inside, carried to the next call. */
    dwell: Dwell | null;
    /** Whether the target leaves the row where it was. */
    isNoop: boolean;
}

export function findDropTarget(y: number, rows: RowBox[], originIndex: number, dwell: Dwell | null, now: number): DropResult {
    if (rows.length === 0) {
        return { target: { kind: "gap", gap: 0 }, dwell: null, isNoop: true };
    }

    const first = rows[0];
    const last = rows[rows.length - 1];
    if (y < first.top) {
        return withNoop({ kind: "gap", gap: 0 }, null, originIndex);
    }
    if (y >= last.bottom) {
        return withNoop({ kind: "gap", gap: rows.length }, null, originIndex);
    }

    let index = rows.findIndex((row) => y >= row.top && y < row.bottom);
    if (index < 0) {
        // Between two rows (a margin): the nearer gap.
        index = rows.findIndex((row) => y < row.top);
        return withNoop({ kind: "gap", gap: Math.max(0, index) }, null, originIndex);
    }

    const row = rows[index];
    const height = Math.max(1, row.bottom - row.top);
    const zone = (y - row.top) / height;
    const inMiddle = zone >= 0.25 && zone <= 0.75;

    if (inMiddle && row.canHoldChildren && index !== originIndex) {
        const nextDwell = dwell && dwell.index === index ? dwell : { index, since: now };
        if (now - nextDwell.since >= DROP_INSIDE_DELAY_MS) {
            return { target: { kind: "inside", index }, dwell: nextDwell, isNoop: false };
        }
        return withNoop({ kind: "gap", gap: zone < 0.5 ? index : index + 1 }, nextDwell, originIndex);
    }

    return withNoop({ kind: "gap", gap: zone < 0.5 ? index : index + 1 }, null, originIndex);
}

function withNoop(target: DropTarget, dwell: Dwell | null, originIndex: number): DropResult {
    const isNoop = target.kind === "gap" && (target.gap === originIndex || target.gap === originIndex + 1);
    return { target, dwell, isNoop };
}

/** The branch operation a target stands for, against the ids of the rows in their order. */
export type MoveOp =
    | { kind: "before"; branchId: string }
    | { kind: "after"; branchId: string }
    | { kind: "into"; branchId: string };

export function moveOpFor(target: DropTarget, rowBranchIds: string[]): MoveOp | null {
    if (target.kind === "inside") {
        const branchId = rowBranchIds[target.index];
        return branchId ? { kind: "into", branchId } : null;
    }
    if (target.gap < rowBranchIds.length) {
        return { kind: "before", branchId: rowBranchIds[target.gap] };
    }
    const lastId = rowBranchIds[rowBranchIds.length - 1];
    return lastId ? { kind: "after", branchId: lastId } : null;
}

/** How to put a moved note back where it was among `siblingBranchIds` (its old siblings, itself included). */
export type UndoPlan =
    | { kind: "after"; branchId: string }
    | { kind: "before"; branchId: string }
    | { kind: "into"; parentNoteId: string };

export function planUndo(siblingBranchIds: string[], movedBranchId: string, parentNoteId: string): UndoPlan {
    const index = siblingBranchIds.indexOf(movedBranchId);
    const previous = index > 0 ? siblingBranchIds[index - 1] : undefined;
    const next = index >= 0 ? siblingBranchIds[index + 1] : undefined;
    if (previous) {
        return { kind: "after", branchId: previous };
    }
    if (next) {
        return { kind: "before", branchId: next };
    }
    return { kind: "into", parentNoteId };
}
