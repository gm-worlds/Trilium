/**
 * Where a voice note's embed and transcript go. The rules are pure so the specs can state them;
 * `editor_ops.ts` applies them to a CKEditor model.
 */
import { t } from "../../../services/i18n.js";

export type EmbedPlacement = "marker" | "end" | "reopen";

/**
 * Where the embed of a finished recording goes: at the caret where the recording started while the
 * editor still holds that note and the place is still in it, at the end of the note when that
 * block is gone, and in the note opened again when the editor shows another note by now.
 */
export function decideEmbedPlacement({ editorAlive, editorNoteId, noteId, markerRoot }: {
    editorAlive: boolean;
    editorNoteId: string | null | undefined;
    noteId: string;
    /** The root name of the start marker's range, or `null` when the marker is gone. */
    markerRoot: string | null;
}): EmbedPlacement {
    if (!editorAlive || editorNoteId !== noteId) {
        return "reopen";
    }
    return markerRoot && markerRoot !== "$graveyard" ? "marker" : "end";
}

/** A transcript as note HTML: a collapsible "Transcript" block, or a block quote without one. */
export function transcriptHtml(text: string, title: string, collapsible: boolean) {
    const paragraphs = text
        .split(/\n\s*\n|\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => `<p>${escapeText(line)}</p>`)
        .join("");
    const body = paragraphs || "<p></p>";
    return collapsible
        ? `<details class="trilium-collapsible" open=""><summary>${escapeText(title)}</summary>${body}</details>`
        : `<blockquote>${body}</blockquote>`;
}

/**
 * `noteHtml` with `insert` right after the first embed of `attachmentId`, or at the end when the
 * note holds no such embed. For a note no open editor holds.
 */
export function insertAfterAttachmentEmbed(noteHtml: string, attachmentId: string, insert: string) {
    const id = attachmentId.replace(/[^A-Za-z0-9_]/g, "");
    const open = new RegExp(`<(figure|section)\\b[^>]*data-attachment-id="${id}"[^>]*>`, "i");
    const match = open.exec(noteHtml);
    if (!match) {
        return noteHtml + insert;
    }
    const tag = match[1].toLowerCase();
    const end = findClosing(noteHtml, tag, match.index + match[0].length);
    if (end < 0) {
        return noteHtml + insert;
    }
    return noteHtml.slice(0, end) + insert + noteHtml.slice(end);
}

function findClosing(html: string, tag: string, from: number) {
    const pattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
    pattern.lastIndex = from;
    let depth = 1;
    for (let m = pattern.exec(html); m; m = pattern.exec(html)) {
        depth += m[1] ? -1 : 1;
        if (depth === 0) {
            return m.index + m[0].length;
        }
    }
    return -1;
}

export function escapeText(text: string) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The file name of a recording made at `date`, unique to the second, starting with `name`. */
export function recordingFileName(date: Date, extension: string, name = t("tf.reach.voice_note")) {
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
    return `${name} ${stamp}.${extension}`;
}
