/**
 * Sync from a desktop app into an embedded engine (the host's desktop channel).
 *
 * An embedded engine refuses Trilium's sync routes unless the host marks the request as its
 * sync channel (`apps/server/src/tf/route_policy.ts`). What arrives that way is applied by
 * upstream's `sync_update.ts`, which writes rows directly and fires only the `*_SYNCED` events.
 * Two hooks there call into this file:
 *
 * - {@link tfAcceptSyncedEntity} drops rows the host manages: refused options (sync, AI,
 *   backups, HTML tags, ...), per-person options (`tfu.*`) and ETAPI tokens. A desktop app keeps
 *   them locally; they never reach the engine.
 * - {@link tfBeforeSyncedEntity} / {@link tfAfterSyncedEntity} turn the applied rows into the
 *   same change events a browser edit makes (created, title, content, moved, deleted), so the
 *   host's search index, activity and save guard see desktop edits too.
 */
import type { EntityChange, EntityRow } from "@triliumnext/commons";

import becca from "../becca/becca.js";
import type BNote from "../becca/entities/bnote.js";
import { emit, type TfEvent, type TfEventKind } from "./events.js";
import { isTfEmbedded } from "./identity.js";
import { TF_USER_OPTION_PREFIX } from "./options.js";
import { isTfRefusedOption } from "./policy.js";
import { recordTfContentWrite } from "./save_guard.js";

interface NoteBefore {
    existed: boolean;
    title?: string;
    blobId?: string;
    isDeleted?: boolean;
}

interface BranchBefore {
    existed: boolean;
    parentNoteId?: string;
}

type Before = { kind: "note"; state: NoteBefore } | { kind: "branch"; state: BranchBefore } | null;

/** Whether an incoming synced row may be applied. Always `true` outside embed mode. */
export function tfAcceptSyncedEntity(ec: Pick<EntityChange, "entityName" | "entityId">, row: EntityRow | undefined): boolean {
    if (!isTfEmbedded()) {
        return true;
    }

    if (ec.entityName === "etapi_tokens") {
        return false;
    }

    if (ec.entityName === "options") {
        const name = String((row as { name?: unknown } | undefined)?.name ?? ec.entityId ?? "");
        if (!name || name.startsWith(TF_USER_OPTION_PREFIX) || name.startsWith("tf") || isTfRefusedOption(name)) {
            return false;
        }
    }

    return true;
}

/** What becca knew about the entity before the row is applied (to tell a rename from a save). */
export function tfBeforeSyncedEntity(ec: Pick<EntityChange, "entityName" | "entityId">): Before {
    if (!isTfEmbedded() || !becca.loaded) {
        return null;
    }

    if (ec.entityName === "notes") {
        const note = becca.getNote(ec.entityId);
        return {
            kind: "note",
            state: note ? { existed: true, title: note.title, blobId: note.blobId, isDeleted: note.isDeleted } : { existed: false }
        };
    }

    if (ec.entityName === "branches") {
        const branch = becca.getBranch(ec.entityId);
        return { kind: "branch", state: branch ? { existed: true, parentNoteId: branch.parentNoteId } : { existed: false } };
    }

    return null;
}

/** Emits the change events for a row `sync_update.ts` has applied (becca is up to date by now). */
export function tfAfterSyncedEntity(ec: Pick<EntityChange, "entityName" | "entityId" | "isErased">, row: EntityRow | undefined, before: Before) {
    if (!isTfEmbedded()) {
        return;
    }

    const deleted = !!ec.isErased || !!(row as { isDeleted?: unknown } | undefined)?.isDeleted;

    if (ec.entityName === "notes" && before?.kind === "note") {
        const prior = before.state;
        if (deleted) {
            if (prior.existed && !prior.isDeleted) {
                emitNote("note.deleted", ec.entityId, prior.title);
            }
            return;
        }

        const note = becca.getNote(ec.entityId);
        if (!note) {
            return;
        }
        if (!prior.existed || prior.isDeleted) {
            emitForNote(prior.existed ? "note.restored" : "note.created", note, { parentNoteId: note.getParentNotes()[0]?.noteId });
            return;
        }
        if (prior.title !== note.title) {
            emitForNote("note.title", note);
        }
        if (prior.blobId !== note.blobId && note.blobId && hasBlob(note.blobId)) {
            contentChanged(note);
        }
        return;
    }

    if (ec.entityName === "blobs" && !deleted) {
        const blobId = String((row as { blobId?: unknown } | undefined)?.blobId ?? ec.entityId);
        for (const note of notesWithBlob(blobId)) {
            contentChanged(note);
        }
        return;
    }

    if (ec.entityName === "branches" && before?.kind === "branch" && !deleted) {
        const branch = becca.getBranch(ec.entityId);
        const prior = before.state;
        const note = branch?.childNote;
        if (branch && note && !note.isDeleted && (!prior.existed || prior.parentNoteId !== branch.parentNoteId)) {
            // A move arrives as a new branch (and the old one deleted); a new note's first branch
            // follows its note row, which already said "created".
            if (note.getParentBranches().length > 1 || prior.existed) {
                emitForNote("note.moved", note, { parentNoteId: branch.parentNoteId });
            }
        }
        return;
    }

    if (ec.entityName === "attributes") {
        const noteId = String((row as { noteId?: unknown } | undefined)?.noteId ?? "");
        const note = noteId ? becca.getNote(noteId) : null;
        if (note) {
            emitForNote("attribute.changed", note);
        }
    }
}

function contentChanged(note: BNote) {
    recordTfContentWrite(note);
    emitForNote("note.content", note, { blobId: note.blobId });
}

function hasBlob(blobId: string) {
    return !!becca.getBlob({ blobId });
}

function notesWithBlob(blobId: string): BNote[] {
    return Object.values(becca.notes).filter((note) => note.blobId === blobId && !note.isDeleted);
}

function emitForNote(kind: TfEventKind, note: BNote, extra: Partial<TfEvent> = {}) {
    if (note.noteId.startsWith("_")) {
        return;
    }
    emit({ kind, noteId: note.noteId, title: note.getTitleOrProtected(), ...extra });
}

function emitNote(kind: TfEventKind, noteId: string, title: string | undefined) {
    if (noteId.startsWith("_")) {
        return;
    }
    emit({ kind, noteId, ...(title !== undefined ? { title } : {}) });
}
