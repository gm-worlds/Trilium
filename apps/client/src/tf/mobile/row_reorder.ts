/**
 * "Move up" and "Move down" in a note's menu on a phone: the way to change the order of notes
 * without dragging (a long press and a drag is hard or impossible for some people, and a screen
 * reader cannot do it at all). Only inside Taskforce, with a finger, for people who may edit.
 */
import type { MenuItem } from "../../menus/context_menu.js";
import branchService from "../../services/branches.js";
import froca from "../../services/froca.js";
import { t } from "../../services/i18n.js";
import { getTfBootstrap, isTfTouch } from "../state.js";

/** The neighbours of `branchId` among its parent's children, in their order. */
export function neighbours(siblingBranchIds: string[], branchId: string): { before: string | null; after: string | null } {
    const at = siblingBranchIds.indexOf(branchId);
    if (at < 0) {
        return { before: null, after: null };
    }
    return { before: siblingBranchIds[at - 1] ?? null, after: siblingBranchIds[at + 1] ?? null };
}

interface Row {
    note: { noteId: string };
    branch?: { branchId: string; parentNoteId: string } | null;
}

/** The two rows for the tree menu; none where they do not apply. */
export function tfReorderMenuItems<T>({ note, branch }: Row): MenuItem<T>[] {
    if (!isTfTouch() || getTfBootstrap()?.user?.role !== "edit" || !branch || note.noteId === "root") {
        return [];
    }
    const parent = froca.getNoteFromCache(branch.parentNoteId);
    // A parent that sorts its children by itself (#sorted) or a search result has no order to change.
    if (!parent || parent.type === "search" || parent.hasLabel("sorted")) {
        return [];
    }
    const { before, after } = neighbours(parent.getChildBranches().map((b) => b.branchId), branch.branchId);
    return [
        {
            title: t("tf.move_up"),
            uiIcon: "bx bx-up-arrow-alt",
            enabled: before !== null,
            handler: () => void (before && branchService.moveBeforeBranch([ branch.branchId ], before))
        },
        {
            title: t("tf.move_down"),
            uiIcon: "bx bx-down-arrow-alt",
            enabled: after !== null,
            handler: () => void (after && branchService.moveAfterBranch([ branch.branchId ], after))
        }
    ] as MenuItem<T>[];
}
