/**
 * English strings of the Taskforce embedding. They are added to i18next's `translation`
 * namespace under `tf.*` at start-up instead of living in the upstream catalogue, so a rebase onto
 * a new upstream release never conflicts on them. Other languages fall back to English.
 */
import i18next from "i18next";

export const TF_STRINGS_EN = {
    back_to_taskforce: "Back to Taskforce (tabs and projects)",
    fork_label: "Taskforce build",
    fork_text: "NoteForce, the Taskforce fork of Trilium Notes",
    protected_open_by: "Protected notes are open for everyone in this notebook (unlocked by {{name}})",
    protected_open: "Protected notes are open for everyone in this notebook",
    read_only: "This notebook is read-only for you.",
    session_lost: "Your notebook session ended. Reload the page to continue.",
    conflict_title: "This note changed",
    conflict_message: "{{name}} changed this note while you were typing.",
    conflict_message_unknown: "Someone else changed this note while you were typing.",
    conflict_hint: "Choose which text to keep. Your text is not lost until you choose.",
    conflict_keep_both: "Keep both",
    conflict_keep_both_hint: "Saves your text as a new note next to this one, then shows theirs.",
    conflict_use_theirs: "Use theirs",
    conflict_use_theirs_hint: "Drops your changes and shows their version.",
    conflict_use_mine: "Use mine",
    conflict_use_mine_hint: "Saves your text. Their version stays in the note's revisions.",
    conflict_your_version: "{{title}} (your version)"
};

let added = false;

export function addTfTranslations() {
    if (added) {
        return;
    }
    added = true;
    i18next.addResourceBundle("en", "translation", { tf: TF_STRINGS_EN }, true, false);
}
