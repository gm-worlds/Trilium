/**
 * Save guard for embedded notebooks: stops one person's editor from silently replacing what
 * another person saved while they were typing.
 *
 * The client sends the blob id its editor started from in `tf-base-blob` with every
 * `PUT /api/notes/:noteId/data`. When the note has moved on since, and the person who moved it is
 * someone else (or unknown, e.g. after a restart), the save is refused with 409 and the client asks
 * what to do. `tf-base-blob: *` forces the write after keeping the current content as a revision.
 *
 * A save from a stale base by the person who wrote last goes through only when it comes from the
 * same client (`tf-client-id`, else `trilium-component-id`, which names the editor) and its base is
 * the blob that client's last write replaced: the editor sent a second save before the answer to
 * the first. Any other stale base, such as a phone and a desktop open on the same note, or a to-do
 * ticked from the list before an editor with unsaved changes saves, is answered with 409 as well.
 */
import type { Request } from "../http_interface.js";
import becca from "../becca/becca.js";
import type BNote from "../becca/entities/bnote.js";
import * as cls from "../services/context.js";
import { getTfUser, isTfEmbedded } from "./identity.js";

export const TF_BASE_BLOB_HEADER = "tf-base-blob";
/** Names the client session of a save. Optional: without it the editor's `trilium-component-id` counts. */
export const TF_CLIENT_ID_HEADER = "tf-client-id";
const COMPONENT_ID_HEADER = "trilium-component-id";
const PENDING_SAVE_KEY = "tfPendingSave";

export interface TfWriter {
    id: string;
    name: string;
}

interface LastWrite {
    blobId: string | undefined;
    by: TfWriter | null;
    at: string;
    /**
     * Bases a later save from the same client may still carry: the blob this write replaced and,
     * when the write itself came from an older base of that client, that base. Empty unless the
     * write was a guarded save.
     */
    acceptedBases: string[];
    /** The client that made the write, known only for a guarded save. */
    clientId: string | null;
}

interface PendingSave {
    noteId: string;
    acceptedBases: string[];
    clientId: string | null;
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
    const pending = getPendingSave();
    const fromGuardedSave = pending?.noteId === note.noteId;
    lastWrites.set(note.noteId, {
        blobId: note.blobId,
        by: user ? { id: user.id, name: user.name } : null,
        at: new Date().toISOString(),
        acceptedBases: fromGuardedSave ? pending.acceptedBases : [],
        clientId: fromGuardedSave ? pending.clientId : null
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

    const clientId = getClientId(req);
    const me = getTfUser();
    const last = lastWrites.get(note.noteId);
    const sameClientWroteLast = !!me && !!clientId && last?.by?.id === me.id
        && last.blobId === note.blobId && last.clientId === clientId;

    if (baseBlobId === "*") {
        if (!sameClientWroteLast) {
            keepCurrentAsRevision(note);
        }
        setPendingSave(note, clientId, []);
        return null;
    }

    if (baseBlobId === note.blobId) {
        setPendingSave(note, clientId, []);
        return null;
    }

    if (sameClientWroteLast && last.acceptedBases.includes(baseBlobId)) {
        setPendingSave(note, clientId, [ baseBlobId ]);
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
    const author = last?.by?.name;
    note.saveRevision({
        description: author ? `Version by ${author}, kept before it was replaced` : "Kept before it was replaced",
        source: "manual"
    });
}

function getClientId(req: Request<{ noteId: string }>): string | null {
    for (const name of [ TF_CLIENT_ID_HEADER, COMPONENT_ID_HEADER ]) {
        const raw = req.headers[name];
        const value = Array.isArray(raw) ? raw[0] : raw;
        if (value && value.length <= 128) {
            return `${name}:${value}`;
        }
    }
    return null;
}

/** Remembers, for the write that follows, which client makes it and which bases stay acceptable. */
function setPendingSave(note: BNote, clientId: string | null, olderBases: string[]) {
    const acceptedBases = [ ...olderBases, ...(note.blobId ? [ note.blobId ] : []) ];
    const pending: PendingSave = { noteId: note.noteId, acceptedBases, clientId };
    try {
        cls.set(PENDING_SAVE_KEY, pending);
    } catch {
        // Outside an execution context (a direct call in a spec) the write is recorded without a client.
    }
}

function getPendingSave(): PendingSave | undefined {
    try {
        return cls.get<PendingSave>(PENDING_SAVE_KEY);
    } catch {
        return undefined;
    }
}
