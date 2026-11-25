/**
 * Change events for Taskforce: what happened to which note, and who did it.
 *
 * Built from upstream's entity event bus (`services/events.ts`), so no route needs a hook. Each
 * event goes to the sink the host registered with {@link setTfEventSink}; the server batches them
 * and posts them to `TF_EVENTS_URL` (`apps/server/src/tf/events_sender.ts`).
 */
import becca from "../becca/becca.js";
import eventService from "../services/events.js";
import type BAttribute from "../becca/entities/battribute.js";
import type BBranch from "../becca/entities/bbranch.js";
import type BNote from "../becca/entities/bnote.js";
import type BRevision from "../becca/entities/brevision.js";
import * as cls from "../services/context.js";
import { getTfRoute, getTfUser } from "./identity.js";
import { recordTfContentWrite } from "./save_guard.js";
import { recordTfProtectedSession } from "./protected.js";

export type TfEventKind =
    | "note.created"
    | "note.content"
    | "note.title"
    | "note.moved"
    | "note.deleted"
    | "note.restored"
    | "revision.created"
    | "attribute.changed"
    | "protected.unlocked"
    | "protected.locked";

export interface TfEvent {
    kind: TfEventKind;
    /** `root` for the `protected.*` kinds, which concern the whole notebook. */
    noteId: string;
    title?: string;
    parentNoteId?: string;
    revisionId?: string;
    blobId?: string;
    /** `null` when the engine acted on its own, such as a protected session timing out. */
    userId: string | null;
    userName: string | null;
    at: string;
}

export type TfEventSink = (event: TfEvent) => void;

let sink: TfEventSink | null = null;
let subscribed = false;

export function setTfEventSink(newSink: TfEventSink | null) {
    sink = newSink;
}

/** Subscribes to upstream's entity events. Idempotent; called by `initTfCore()`. */
export function subscribeTfEvents() {
    if (subscribed) {
        return;
    }
    subscribed = true;

    eventService.subscribe(eventService.ENTITY_CREATED, ({ entityName, entity }) => {
        if (entityName === "notes") {
            const note = entity as BNote;
            emitForNote("note.created", note, { parentNoteId: note.getParentNotes()[0]?.noteId });
        } else if (entityName === "revisions") {
            const revision = entity as BRevision;
            const note = revision.getNote();
            if (note) {
                emitForNote("revision.created", note, { revisionId: revision.revisionId });
            }
        } else if (entityName === "branches") {
            rememberCreatedBranch(entity as BBranch);
        }
    });

    eventService.subscribe(eventService.ENTITY_CHANGED, ({ entityName, entity }) => {
        if (entityName === "notes" && isRestoreRoute()) {
            const note = entity as BNote;
            if (!note.isDeleted) {
                emitForNote("note.restored", note, { parentNoteId: note.getParentNotes()[0]?.noteId });
            }
        } else if (entityName === "attributes") {
            emitForAttribute(entity as BAttribute);
        }
    });

    eventService.subscribe(eventService.ENTITY_DELETED, ({ entityName, entity }) => {
        if (entityName === "notes") {
            emitForNote("note.deleted", entity as BNote);
        } else if (entityName === "branches") {
            const branch = entity as BBranch;
            const moved = takeCreatedBranch(branch.noteId, branch.branchId ?? "");
            const note = branch.childNote;
            if (moved && note && !note.isDeleted) {
                emitForNote("note.moved", note, { parentNoteId: moved.parentNoteId });
            }
        } else if (entityName === "attributes") {
            emitForAttribute(entity as BAttribute);
        }
    });

    eventService.subscribe(eventService.NOTE_CONTENT_CHANGE, ({ entity }) => {
        const note = entity as BNote;
        recordTfContentWrite(note);
        emitForNote("note.content", note, { blobId: note.blobId });
    });

    eventService.subscribe(eventService.NOTE_TITLE_CHANGED, (note: BNote) => {
        emitForNote("note.title", note);
    });

    eventService.subscribe(eventService.ENTER_PROTECTED_SESSION, () => {
        recordTfProtectedSession(true);
        emit({ kind: "protected.unlocked", noteId: "root" });
    });

    eventService.subscribe(eventService.LEAVE_PROTECTED_SESSION, () => {
        recordTfProtectedSession(false);
        emit({ kind: "protected.locked", noteId: "root" });
    });
}

/** Builds an event with the person in context and hands it to the sink. */
export function emit(partial: Omit<TfEvent, "userId" | "userName" | "at">) {
    if (!sink) {
        return;
    }

    const user = getTfUser();
    sink({
        ...partial,
        userId: user?.id ?? null,
        userName: user?.name ?? null,
        at: new Date().toISOString()
    });
}

function emitForNote(kind: TfEventKind, note: BNote | undefined | null, extra: Partial<TfEvent> = {}) {
    if (!note || isSystemNote(note.noteId)) {
        return;
    }

    emit({ kind, noteId: note.noteId, title: note.getTitleOrProtected(), ...extra });
}

function emitForAttribute(attribute: BAttribute) {
    if (isSystemNote(attribute.noteId)) {
        return;
    }
    emitForNote("attribute.changed", becca.getNote(attribute.noteId));
}

/** Hidden, launcher and help notes have ids starting with `_` and are not part of a notebook's content. */
function isSystemNote(noteId: string | undefined) {
    return !noteId || noteId.startsWith("_");
}

function isRestoreRoute() {
    return getTfRoute() === "/api/notes/:noteId/undelete";
}

// A move saves a clone of the branch under the new parent, then deletes the old one, in the same
// execution context. The created branches are kept there until the deletion pairs them up.
const CREATED_BRANCHES_KEY = "tfCreatedBranches";

function rememberCreatedBranch(branch: BBranch) {
    try {
        const created = cls.get<BBranch[]>(CREATED_BRANCHES_KEY) ?? [];
        created.push(branch);
        cls.set(CREATED_BRANCHES_KEY, created);
    } catch {
        // No execution context, so the branch cannot be part of a move.
    }
}

function takeCreatedBranch(noteId: string, deletedBranchId: string): BBranch | undefined {
    let created: BBranch[] | undefined;
    try {
        created = cls.get<BBranch[]>(CREATED_BRANCHES_KEY);
    } catch {
        return undefined;
    }

    return created?.find((branch) => branch.noteId === noteId && branch.branchId !== deletedBranchId);
}
