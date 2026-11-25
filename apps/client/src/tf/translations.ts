/**
 * Strings of the Taskforce embedding, in English and Dutch. They are added to i18next's
 * `translation` namespace under `tf.*` at start-up instead of living in the upstream catalogue, so
 * a rebase onto a new upstream release never conflicts on them. Other languages fall back to
 * English. Dutch addresses the reader with "u".
 */
import i18next from "i18next";

export const TF_STRINGS_EN = {
    back_to_taskforce: "Back to Taskforce",
    taskforce: "Taskforce",
    fork_label: "Taskforce build",
    fork_text: "NoteForce, the Taskforce fork of Trilium Notes",
    protected_open_by: "Protected notes are open for everyone in this notebook. {{name}} unlocked them.",
    protected_open: "Protected notes are open for everyone in this notebook.",
    read_only: "You can only read this notebook.",
    session_lost: "The connection to this notebook ended. Reload the page to continue.",
    conflict_title: "This note changed",
    conflict_message: "{{name}} changed this note while you were typing.",
    conflict_message_unknown: "Someone else changed this note while you were typing.",
    conflict_hint: "Choose which text to keep. Your text stays safe until you choose.",
    conflict_keep_both: "Keep both",
    conflict_keep_both_hint: "Saves your text as a new note next to this one, then shows theirs.",
    conflict_use_theirs: "Use theirs",
    conflict_use_theirs_hint: "Drops your changes and shows their version.",
    conflict_use_mine: "Use mine",
    conflict_use_mine_hint: "Saves your text. Their version stays in the note's revisions.",
    conflict_your_version: "{{title}}, your version",
    row_more: "More for {{title}}",
    move_up: "Move up",
    move_down: "Move down",
    add_note_in: "Add a note in {{title}}",
    untitled: "Untitled",
    moved_note: "Moved \u201c{{title}}\u201d",
    undo: "Undo",
    text_size: "Text size",
    text_smaller: "Smaller text",
    text_larger: "Larger text",
    text_reset: "Normal size",
    block_handle: "Drag to move this block"
};

export const TF_STRINGS_NL: typeof TF_STRINGS_EN = {
    back_to_taskforce: "Terug naar Taskforce",
    taskforce: "Taskforce",
    fork_label: "Taskforce-versie",
    fork_text: "NoteForce, de Taskforce-versie van Trilium Notes",
    protected_open_by: "Beschermde notities zijn open voor iedereen in dit notitieboek. {{name}} heeft ze ontgrendeld.",
    protected_open: "Beschermde notities zijn open voor iedereen in dit notitieboek.",
    read_only: "U kunt dit notitieboek alleen lezen.",
    session_lost: "De verbinding met dit notitieboek is verbroken. Laad de pagina opnieuw om verder te gaan.",
    conflict_title: "Deze notitie is gewijzigd",
    conflict_message: "{{name}} heeft deze notitie gewijzigd terwijl u aan het typen was.",
    conflict_message_unknown: "Iemand anders heeft deze notitie gewijzigd terwijl u aan het typen was.",
    conflict_hint: "Kies welke tekst u wilt houden. Tot u kiest, blijft uw tekst bewaard.",
    conflict_keep_both: "Beide houden",
    conflict_keep_both_hint: "Slaat uw tekst op als nieuwe notitie naast deze en toont dan de hunne.",
    conflict_use_theirs: "Hun versie gebruiken",
    conflict_use_theirs_hint: "Laat uw wijzigingen vallen en toont hun versie.",
    conflict_use_mine: "Mijn versie gebruiken",
    conflict_use_mine_hint: "Slaat uw tekst op. Hun versie blijft bewaard in de revisies van de notitie.",
    conflict_your_version: "{{title}}, uw versie",
    row_more: "Meer voor {{title}}",
    move_up: "Omhoog verplaatsen",
    move_down: "Omlaag verplaatsen",
    add_note_in: "Notitie toevoegen in {{title}}",
    untitled: "Zonder titel",
    moved_note: "\u201c{{title}}\u201d verplaatst",
    undo: "Ongedaan maken",
    text_size: "Tekstgrootte",
    text_smaller: "Kleinere tekst",
    text_larger: "Grotere tekst",
    text_reset: "Normale grootte",
    block_handle: "Sleep om dit blok te verplaatsen"
};

let added = false;

export function addTfTranslations() {
    if (added) {
        return;
    }
    added = true;
    i18next.addResourceBundle("en", "translation", { tf: TF_STRINGS_EN }, true, false);
    i18next.addResourceBundle("nl", "translation", { tf: TF_STRINGS_NL }, true, false);
}
