/**
 * The voice note's changes to a text editor's model: the marker that keeps the place where a
 * recording started, the upload of the audio as an embedded attachment (the paperclip's
 * `fileUpload` command, so progress and the embed are upstream's), and the transcript under it.
 */
import type { CKTextEditor, ModelElement } from "@triliumnext/ckeditor5";

import { decideEmbedPlacement, type EmbedPlacement, transcriptHtml } from "./placement.js";

const START_MARKER = "tf-voice-start:";
const USER_MARKER = "tf-voice-user";

interface FileLoaderLike {
    uploadedPercent: number;
    status: string;
}

interface UploadData {
    fileName: string;
    loader: FileLoaderLike;
    done: Promise<void>;
}

interface UploadEmitter {
    on(event: "upload", callback: (evt: unknown, data: UploadData) => void): void;
    off(event: "upload", callback: (evt: unknown, data: UploadData) => void): void;
}

export function editorNoteId(editor: CKTextEditor) {
    const getNoteId = editor.config.get("getNoteId") as (() => string | undefined) | undefined;
    return getNoteId?.() ?? null;
}

export function isEditorAlive(editor: CKTextEditor) {
    return editor.state !== "destroyed";
}

/** Marks the caret's place; the marker moves with the text typed meanwhile. */
export function markStart(editor: CKTextEditor, id: string) {
    const name = START_MARKER + id;
    const model = editor.model;
    const position = model.document.selection.getFirstPosition();
    if (!position) {
        return name;
    }
    model.change((writer) => {
        writer.addMarker(name, { range: writer.createRange(position), usingOperation: false, affectsData: false });
    });
    return name;
}

export function clearMarker(editor: CKTextEditor, name: string) {
    if (!isEditorAlive(editor) || !editor.model.markers.has(name)) {
        return;
    }
    editor.model.change((writer) => writer.removeMarker(name));
}

export function placementFor(editor: CKTextEditor, noteId: string, markerName: string): EmbedPlacement {
    const marker = isEditorAlive(editor) ? editor.model.markers.get(markerName) : null;
    return decideEmbedPlacement({
        editorAlive: isEditorAlive(editor),
        editorNoteId: isEditorAlive(editor) ? editorNoteId(editor) : null,
        noteId,
        markerRoot: marker ? marker.getRange().root.rootName ?? null : null
    });
}

export interface StartedUpload {
    element: ModelElement;
    /** Resolves with the attachment, or `null` when the upload failed (the editor removed the embed). */
    done: Promise<string | null>;
    progress(): number;
}

/**
 * Uploads `file` as an attachment of the note and embeds it at the start marker (or at the end of
 * the note), leaving the person's own selection where it was. `null` when the editor cannot take
 * the embed now (read-only, or the command is off).
 */
export function uploadAtPlace(editor: CKTextEditor, file: File, markerName: string | null): StartedUpload | null {
    const model = editor.model;
    const root = model.document.getRoot();
    const command = editor.commands.get("fileUpload");
    if (!root || !command || editor.isReadOnly) {
        return null;
    }

    const userRange = model.document.selection.getFirstRange();
    model.change((writer) => {
        if (userRange) {
            writer.addMarker(USER_MARKER, { range: userRange, usingOperation: false, affectsData: false });
        }
        const marker = markerName ? model.markers.get(markerName) : null;
        const start = marker && marker.getRange().root.rootName !== "$graveyard" ? marker.getStart() : null;
        if (start) {
            writer.setSelection(start);
            return;
        }
        const last = root.getChild(root.childCount - 1);
        if (last && last.is("element", "paragraph")) {
            writer.setSelection(writer.createPositionAt(last, "end"));
        } else {
            const paragraph = writer.createElement("paragraph");
            writer.insert(paragraph, root, "end");
            writer.setSelection(writer.createPositionAt(paragraph, 0));
        }
    });

    if (!command.isEnabled) {
        restoreSelection(editor);
        return null;
    }

    const uploads = editor.plugins.get("FileUploadEditing") as unknown as UploadEmitter;
    let loader: FileLoaderLike | null = null;
    let resolveDone: (attachmentId: string | null) => void = () => {};
    const done = new Promise<string | null>((resolve) => {
        resolveDone = resolve;
    });
    let element: ModelElement | null = null;
    const onUpload = (_evt: unknown, data: UploadData) => {
        if (data.fileName !== file.name) {
            return;
        }
        uploads.off("upload", onUpload);
        loader = data.loader;
        void data.done.then(() => {
            const attachmentId = element && element.root.rootName !== "$graveyard"
                ? (element.getAttribute("attachmentId") as string | undefined) ?? null
                : null;
            resolveDone(attachmentId);
        });
    };
    uploads.on("upload", onUpload);
    editor.execute("fileUpload", { file: [ file ], asEmbed: true });
    element = findUploadPlaceholder(editor, file.name);
    restoreSelection(editor);

    if (!element) {
        uploads.off("upload", onUpload);
        return null;
    }

    return {
        element,
        done,
        progress: () => Math.round(loader?.uploadedPercent ?? 0)
    };
}

function restoreSelection(editor: CKTextEditor) {
    const model = editor.model;
    model.change((writer) => {
        const marker = model.markers.get(USER_MARKER);
        if (marker) {
            if (marker.getRange().root.rootName !== "$graveyard") {
                writer.setSelection(marker.getRange());
            }
            writer.removeMarker(USER_MARKER);
        }
    });
}

function findUploadPlaceholder(editor: CKTextEditor, fileName: string): ModelElement | null {
    for (const element of embedsOf(editor)) {
        if (element.getAttribute("uploadFileName") === fileName) {
            return element;
        }
    }
    return null;
}

function* embedsOf(editor: CKTextEditor): Generator<ModelElement> {
    const root = editor.model.document.getRoot();
    if (!root) {
        return;
    }
    for (const item of editor.model.createRangeIn(root).getItems()) {
        if (item.is("element", "contentEmbed")) {
            yield item as ModelElement;
        }
    }
}

export function findAttachmentEmbed(editor: CKTextEditor, attachmentId: string): ModelElement | null {
    for (const element of embedsOf(editor)) {
        if (element.getAttribute("attachmentId") === attachmentId) {
            return element;
        }
    }
    return null;
}

/**
 * Inserts `text` right under `embed`: a collapsible "Transcript" block where the editor has
 * them, else a block quote. Where the block cannot stand right after the embed (inside a table
 * cell, say), it goes after the top-level block that holds the embed. A read-only editor (someone
 * else has the turn) takes nothing: `false`. The edit asks for the turn like any other.
 */
export function insertTranscript(editor: CKTextEditor, embed: ModelElement, text: string, title: string) {
    if (editor.isReadOnly || !isEditorAlive(editor)) {
        return false;
    }
    const model = editor.model;
    const collapsible = model.schema.isRegistered("details");
    const blockName = collapsible ? "details" : "blockQuote";
    const fragment = editor.data.parse(transcriptHtml(text, title, collapsible));
    model.change((writer) => {
        let position = model.createPositionAfter(embed);
        let holder: ModelElement = embed;
        while (!model.schema.checkChild(position, blockName) && holder.parent && !holder.parent.is("rootElement")) {
            holder = holder.parent as ModelElement;
            position = model.createPositionAfter(holder);
        }
        writer.insert(fragment, position);
    });
    return true;
}
