/**
 * Moves a note by touch through the same branch services the desktop tree's drop uses
 * (`services/branches.ts`), so root, hoisting, search and launcher rules and the server's own
 * checks (a note cannot move into itself or its descendants) apply unchanged. Every move is
 * followed by a toast with "Undo", which puts the note back next to its old neighbours.
 */
import froca from "../../services/froca.js";
import branches from "../../services/branches.js";
import { t } from "../../services/i18n.js";
import toast from "../../services/toast.js";
import ws from "../../services/ws.js";
import { tfHaptic } from "../bridge.js";
import { type MoveOp, planUndo, type UndoPlan } from "./reorder.js";

const UNDO_TOAST_ID = "tf-move-undo";
const UNDO_TIMEOUT_MS = 6000;

/** The branch ids of `parentNoteId`'s children, in the order the tree shows them. */
export function childBranchIds(parentNoteId: string): string[] {
    const parent = froca.getNoteFromCache(parentNoteId);
    if (!parent) {
        return [];
    }
    return parent.getChildNoteIds()
        .map((childId) => parent.childToBranch[childId])
        .filter((branchId): branchId is string => !!branchId);
}

export interface MoveRequest {
    branchId: string;
    op: MoveOp;
    /** The path of the target note for a move into it, so an open note follows. */
    targetNotePath?: string;
    componentId?: string;
}

/** Runs the move and shows the undo toast. Resolves `true` when the move went through. */
export async function moveWithUndo({ branchId, op, targetNotePath, componentId }: MoveRequest): Promise<boolean> {
    const undo = prepareUndo(branchId);
    if (!undo) {
        return false;
    }
    const moved = await runMove(branchId, op, targetNotePath, componentId);
    if (!moved) {
        tfHaptic("warning");
        return false;
    }
    tfHaptic("success");
    offerUndo(undo, op, componentId);
    return true;
}

export interface PreparedUndo {
    noteId: string;
    plan: UndoPlan;
}

/** Notes where the note of `branchId` stands now, before a move. */
export function prepareUndo(branchId: string): PreparedUndo | null {
    const branch = froca.getBranch(branchId);
    if (!branch) {
        return null;
    }
    const { noteId, parentNoteId } = branch;
    return { noteId, plan: planUndo(childBranchIds(parentNoteId), branchId, parentNoteId) };
}

/** Shows the toast whose "Undo" reverses `op` for the note of `undo`. */
export function offerUndo(undo: PreparedUndo, op: MoveOp, componentId?: string) {
    const title = froca.getNoteFromCache(undo.noteId)?.title ?? "";
    toast.showPersistent({
        id: UNDO_TOAST_ID,
        icon: "bx bx-move",
        message: t("tf.moved_note", { title }),
        timeout: UNDO_TIMEOUT_MS,
        buttons: [ {
            text: t("tf.undo"),
            onClick: ({ dismissToast }) => {
                dismissToast();
                void undoMove(undo.noteId, op, undo.plan, componentId);
            }
        } ]
    });
}

async function runMove(branchId: string, op: MoveOp, targetNotePath?: string, componentId?: string) {
    switch (op.kind) {
        case "before":
            return branches.moveBeforeBranch([ branchId ], op.branchId);
        case "after":
            return branches.moveAfterBranch([ branchId ], op.branchId);
        case "into":
            return branches.moveToParentNote([ branchId ], op.branchId, componentId, targetNotePath);
    }
}

/** Puts `noteId` back where {@link planUndo} found it. */
export async function undoMove(noteId: string, op: MoveOp, plan: UndoPlan, componentId?: string) {
    await ws.waitForMaxKnownEntityChangeId();
    const currentParentId = op.kind === "into"
        ? froca.getBranch(op.branchId)?.noteId
        : froca.getBranch(op.branchId)?.parentNoteId;
    const currentBranchId = currentParentId ? await froca.getBranchId(currentParentId, noteId) : null;
    if (!currentBranchId) {
        return false;
    }

    if (plan.kind === "after") {
        return branches.moveAfterBranch([ currentBranchId ], plan.branchId);
    }
    if (plan.kind === "before") {
        return branches.moveBeforeBranch([ currentBranchId ], plan.branchId);
    }
    const parent = froca.getNoteFromCache(plan.parentNoteId);
    const parentBranchId = plan.parentNoteId === "root" ? "none_root" : parent?.getParentBranchIds()[0];
    return parentBranchId ? branches.moveToParentNote([ currentBranchId ], parentBranchId, componentId) : false;
}
