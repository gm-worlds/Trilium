/**
 * What a Word export reads from the notebook: the notes in tree order with their HTML (included
 * notes inlined), and the bytes behind each image. The converter itself lives on the server
 * (`apps/server/src/tf/work/docx.ts`), because the `docx` library is a Node-side dependency that
 * the standalone build does not need.
 */
import becca from "../../becca/becca.js";
import type BNote from "../../becca/entities/bnote.js";
import { NotFoundError } from "../../errors.js";
import { isProtectedSessionAvailable } from "../../services/protected_session.js";
import { encodeUtf8 } from "../../services/utils/binary.js";

export interface TfDocxNote {
    noteId: string;
    title: string;
    /** 0 for the exported note, 1 for its children, and so on. */
    level: number;
    /** HTML of the note's body; code notes come as one `<pre><code>` block. */
    html: string;
}

export interface TfDocxSource {
    title: string;
    notes: TfDocxNote[];
}

export interface TfDocxImage {
    data: Uint8Array;
    mime: string;
}

const MAX_INCLUDE_DEPTH = 4;
const MAX_NOTES = 2000;

/** The note (and with `withChildren` everything under it, depth first in tree order). */
export function collectTfDocxSource(noteId: string, withChildren: boolean): TfDocxSource {
    const top = becca.getNote(noteId);
    if (!top) {
        throw new NotFoundError(`Note '${noteId}' not found.`);
    }

    const notes: TfDocxNote[] = [];
    const visit = (note: BNote, level: number, seen: Set<string>) => {
        if (notes.length >= MAX_NOTES || seen.has(note.noteId)) {
            return;
        }
        seen.add(note.noteId);
        notes.push({ noteId: note.noteId, title: note.getTitleOrProtected(), level, html: noteBodyHtml(note, new Set([ note.noteId ]), 0) });
        if (!withChildren) {
            return;
        }
        for (const child of note.getChildNotes()) {
            if (child.noteId.startsWith("_") || child.isArchived) {
                continue;
            }
            visit(child, level + 1, seen);
        }
    };
    visit(top, 0, new Set());

    return { title: top.getTitleOrProtected(), notes };
}

/**
 * The bytes of an image the note's HTML points at: `api/images/<noteId>/<name>` or
 * `api/attachments/<attachmentId>/image/<name>`, relative or absolute. `null` for anything else.
 */
export function resolveTfDocxImage(src: string): TfDocxImage | null {
    const attachment = /(?:^|\/)api\/attachments\/([A-Za-z0-9_]+)\/image\//.exec(src);
    if (attachment) {
        const row = becca.getAttachment(attachment[1]);
        if (!row || !row.mime.startsWith("image/") || !row.isContentAvailable()) {
            return null;
        }
        const content = row.getContent();
        return { data: toBytes(content), mime: row.mime };
    }
    const image = /(?:^|\/)api\/images\/([A-Za-z0-9_]+)\//.exec(src);
    if (image) {
        const note = becca.getNote(image[1]);
        if (!note || !note.mime.startsWith("image/") || !note.isContentAvailable()) {
            return null;
        }
        return { data: toBytes(note.getContent()), mime: note.mime };
    }
    return null;
}

/** A file name from a note title: letters, digits, spaces, dots, dashes and underscores. */
export function safeDocxFileName(title: string) {
    const cleaned = title.normalize("NFKC")
        .replace(/[^\p{L}\p{N} ._-]+/gu, " ")
        .replace(/\s+/g, " ")
        .replace(/^[ .]+|[ .]+$/g, "")
        .slice(0, 120);
    return `${cleaned || "note"}.docx`;
}

function noteBodyHtml(note: BNote, chain: Set<string>, depth: number): string {
    if (note.isProtected && !isProtectedSessionAvailable()) {
        return "";
    }
    if (!note.isContentAvailable()) {
        return "";
    }
    let content: string | Uint8Array;
    try {
        content = note.getContent();
    } catch {
        return "";
    }
    if (typeof content !== "string") {
        return "";
    }
    if (note.type === "code") {
        return `<pre><code>${escapeHtml(content)}</code></pre>`;
    }
    if (note.type !== "text") {
        return "";
    }
    return inlineIncludes(content, chain, depth);
}

const INCLUDE_RE = /<(figure|section)\b([^>]*\bclass="include-note[^"]*"[^>]*)>([\s\S]*?)<\/\1>/g;

function inlineIncludes(html: string, chain: Set<string>, depth: number): string {
    return html.replace(INCLUDE_RE, (_whole, _tag: string, attrs: string) => {
        const noteId = /\bdata-note-id="([A-Za-z0-9_]+)"/.exec(attrs)?.[1];
        const included = noteId ? becca.getNote(noteId) : null;
        if (!included || chain.has(included.noteId) || depth >= MAX_INCLUDE_DEPTH) {
            return "";
        }
        const inner = noteBodyHtml(included, new Set([ ...chain, included.noteId ]), depth + 1);
        return `<div class="tf-docx-include" data-title="${escapeHtml(included.getTitleOrProtected())}">${inner}</div>`;
    });
}

function toBytes(content: string | Uint8Array): Uint8Array {
    return typeof content === "string" ? encodeUtf8(content) : content;
}

function escapeHtml(text: string) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
