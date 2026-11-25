/**
 * What upstream menus, services and widgets call for the reach features (voice notes, share links,
 * search in other notebooks), kept free of widget imports so services can import it. Each hook
 * does nothing unless the notebook runs embedded; the heavy parts load on first use.
 */
import { useSyncExternalStore } from "preact/compat";

import type FAttachment from "../../entities/fattachment.js";
import type { MenuItem } from "../../menus/context_menu.js";
import { t } from "../../services/i18n.js";
import { getTfBootstrap, isTfEmbedded, isTfHiddenUi, subscribeTf } from "../state.js";

/** `templateNoteId` of the tree's "Record a voice note" rows, which `tfHandleTreeMenuItem()` takes. */
export const TF_VOICE_NOTE_TEMPLATE = "_tfVoiceNote";

const canEdit = () => getTfBootstrap()?.user?.role === "edit";

/** The menu of an audio attachment's embed: "Make a transcript". */
export function tfAttachmentEmbedItems<T>(attachment: FAttachment, editor: unknown): MenuItem<T>[] {
    if (!isTfEmbedded() || !canEdit() || !attachment.mime?.startsWith("audio/")) {
        return [];
    }
    return [ {
        title: t("tf.reach.make_transcript"),
        uiIcon: "bx bx-captions",
        handler: () => {
            void import("./voice/session.js").then(({ makeTranscriptOfAttachment }) =>
                makeTranscriptOfAttachment(attachment, (editor ?? null) as Parameters<typeof makeTranscriptOfAttachment>[1]));
        }
    } ];
}

/** "Record a voice note" among the tree's new-note choices (only where a tree command makes the note). */
export function tfNoteTypeItems<T>(command: T | undefined): MenuItem<T>[] {
    if (!isTfEmbedded() || !canEdit() || (command !== "insertChildNote" && command !== "insertNoteAfter")) {
        return [];
    }
    return [ {
        title: t("tf.reach.record_voice_note"),
        uiIcon: "bx bx-microphone",
        command,
        type: "text",
        templateNoteId: TF_VOICE_NOTE_TEMPLATE
    } as MenuItem<T> ];
}

/** Takes the tree's "Record a voice note" rows; `true` when it did. */
export function tfHandleTreeMenuItem(
    item: { command?: string; templateNoteId?: string },
    { notePath, branchId }: { notePath: string; branchId?: string }
) {
    if (item.templateNoteId !== TF_VOICE_NOTE_TEMPLATE) {
        return false;
    }
    const after = item.command === "insertNoteAfter";
    const parentPath = after ? notePath.split("/").slice(0, -1).join("/") || "root" : notePath;
    void import("./voice/session.js").then(({ recordIntoNewNote }) =>
        recordIntoNewNote(parentPath, after ? "after" : "into", after ? branchId : undefined));
    return true;
}

/** Whether an upstream control is hidden inside Taskforce, following the bootstrap as it arrives. */
export function useTfHiddenUi(name: string) {
    return useSyncExternalStore(subscribeTf, () => isTfHiddenUi(name));
}

/** The note tree's tooltip of a shared note, without the dead `/share` address. */
export function tfSharedTreeTooltip() {
    return isTfEmbedded() ? t("tf.reach.shared_tree") : null;
}

const SHARE_PAGE_LABELS = new Set([
    "shareHiddenFromTree", "shareExternalLink", "shareAlias", "shareOmitDefaultCss", "shareRoot",
    "shareDescription", "shareRaw", "shareDisallowRobotIndexing", "shareCredentials", "shareIndex"
]);

/** The attribute help of the share page labels, which have no effect inside Taskforce. */
export function tfAttributeHelp(attrType: string | undefined, name: string) {
    if (!isTfEmbedded() || attrType !== "label" || !SHARE_PAGE_LABELS.has(name)) {
        return undefined;
    }
    return { description: t("tf.reach.share_attribute_help") };
}

