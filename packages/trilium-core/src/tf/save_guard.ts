/**
 * Save guard for embedded notebooks: stops one person's editor from silently replacing what
 * another person saved while they were typing.
 *
 * The client sends the blob id its editor started from in `tf-base-blob` with every
 * `PUT /api/notes/:noteId/data`. When the note has moved on since, and the person who moved it is
 * someone else (or unknown, e.g. after a restart), the save is refused with 409 and the client asks
 * what to do. `tf-base-blob: *` forces the write after keeping the current content as a revision.
 */
import type { Request } from "../http_interface.js";
import becca from "../becca/becca.js";
import type BNote from "../becca/entities/bnote.js";
import { getTfUser, isTfEmbedded } from "./identity.js";

export const TF_BASE_BLOB_HEADER = "tf-base-blob";

export interface TfWriter {
    id: string;
    name: string;
}

interface LastWrite {
    blobId: string | undefined;
    by: TfWriter | null;
    at: string;
}

export interface TfSaveConflict {
    conflict: true;
    blobId: string | undefined;
    editedBy: TfWriter | null;
    editedAt: string | null;
}

const lastWrites = new Map<string, LastWrite>();

/** Records who wrote a note's content. Subscribed to `NOTE_CONTENT_CHANGE` by `initTfCore()`. */
export function recordTfContentWrite(note: BNote) {
    const user = getTfUser();
    lastWrites.set(note.noteId, {
        blobId: note.blobId,
        by: user ? { id: user.id, name: user.name } : null,
        at: new Date().toISOString()
    });
}

export function getTfLastWrite(noteId: string): LastWrite | undefined {
    return lastWrites.get(noteId);
}

export function clearTfLastWrites() {
    lastWrites.clear();
}

/**
 * Runs before the content write. Returns the `[409, body]` tuple to answer with, or `null` to let
 * the save go ahead. A forced write keeps the current content as a revision first.
 */
export function checkTfSaveGuard(req: Request<{ noteId: string }>): [409, TfSaveConflict] | null {
    if (!isTfEmbedded()) {
        return null;
    }

    const rawHeader = req.headers[TF_BASE_BLOB_HEADER];
    const baseBlobId = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (!baseBlobId) {
        return null;
    }

    const note = becca.getNote(req.params.noteId);
    if (!note) {
        return null;
    }

    if (baseBlobId === "*") {
        keepCurrentAsRevision(note);
        return null;
    }

    if (baseBlobId === note.blobId) {
        return null;
    }

    const me = getTfUser();
    const last = lastWrites.get(note.noteId);
    const lastWriterIsMe = !!me && last?.by?.id === me.id && last.blobId === note.blobId;
    if (lastWriterIsMe) {
        return null;
    }

    return [409, {
        conflict: true,
        blobId: note.blobId,
        editedBy: last?.by ?? null,
        editedAt: last?.at ?? note.utcDateModified ?? null
    }];
}

/** The success body of a guarded save in embed mode, so the client can track the new blob id. */
export function tfSaveResult(noteId: string): { blobId: string | undefined } | undefined {
    if (!isTfEmbedded()) {
        return undefined;
    }
    return { blobId: becca.getNote(noteId)?.blobId };
}

function keepCurrentAsRevision(note: BNote) {
    if (note.isVirtual || !note.isContentAvailable()) {
        return;
    }

    const last = lastWrites.get(note.noteId);
    const me = getTfUser();
    if (last?.by && me && last.by.id === me.id) {
        return;
    }

    const author = last?.by?.name;
    note.saveRevision({
        description: author ? `Version by ${author}, kept before it was replaced` : "Kept before it was replaced",
        source: "manual"
    });
}
