import type { EntityChange, EntityRow } from "@triliumnext/commons";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import becca from "../becca/becca.js";
import * as cls from "../services/context.js";
import notes from "../services/notes.js";
import { getSql } from "../services/sql/index.js";
import syncUpdateService from "../services/sync_update.js";
import { encodeBase64 } from "../services/utils/binary.js";
import { setTfEventSink, type TfEvent } from "./events.js";
import { enableTfEmbed, setTfUser } from "./identity.js";
import { tfAcceptSyncedEntity } from "./sync.js";

const NOW_ISH = "2098-01-01 00:00:00.000Z";
let counter = 0;
let received: TfEvent[] = [];

describe("tf sync from a desktop app", () => {
    beforeAll(() => {
        enableTfEmbed(true);
        setTfEventSink((event) => received.push(event));
    });

    afterAll(() => {
        setTfEventSink(null);
        enableTfEmbed(false);
    });

    afterEach(() => {
        received = [];
    });

    it("drops host-managed rows but keeps their entity change, outside embed mode it accepts all", () => {
        const option = (name: string) => ({ name, value: "x", isSynced: 1 }) as unknown as EntityRow;
        expect(tfAcceptSyncedEntity({ entityName: "options", entityId: "theme" }, option("theme"))).toBe(true);
        for (const name of [ "allowedHtmlTags", "syncServerHost", "aiEnabled", "backupEnabled", "tfu.alice.theme", "tfTreeExpanded" ]) {
            expect({ name, ok: tfAcceptSyncedEntity({ entityName: "options", entityId: name }, option(name)) }).toEqual({ name, ok: false });
        }
        expect(tfAcceptSyncedEntity({ entityName: "etapi_tokens", entityId: "t1" }, undefined)).toBe(false);
        expect(tfAcceptSyncedEntity({ entityName: "notes", entityId: "n1" }, undefined)).toBe(true);

        const before = getSql().getValue<string>("SELECT value FROM options WHERE name = 'allowedHtmlTags'");
        apply([ { entityChange: ec("options", "allowedHtmlTags"), entity: option("allowedHtmlTags") } ]);
        expect(getSql().getValue<string>("SELECT value FROM options WHERE name = 'allowedHtmlTags'")).toBe(before);
        expect(getSql().getValue<string>("SELECT hash FROM entity_changes WHERE entityName = 'options' AND entityId = 'allowedHtmlTags'")).toBe("remote-allowedHtmlTags");

        enableTfEmbed(false);
        try {
            expect(tfAcceptSyncedEntity({ entityName: "etapi_tokens", entityId: "t1" }, undefined)).toBe(true);
        } finally {
            enableTfEmbed(true);
        }
    });

    it("turns a synced rename, new content and deletion into the same events a browser edit makes", () => {
        const noteId = createNote();
        received = [];

        apply([ { entityChange: ec("notes", noteId), entity: noteRow(noteId, { title: "Renamed on the Mac" }) } ]);
        expect(received.map((e) => [ e.kind, e.noteId, e.title, e.userId ])).toEqual([ [ "note.title", noteId, "Renamed on the Mac", "laurie" ] ]);

        received = [];
        const blobId = `tfblob${counter}`;
        apply([
            { entityChange: ec("blobs", blobId), entity: { blobId, content: encodeBase64("<p>new</p>"), dateModified: NOW_ISH, utcDateModified: NOW_ISH } as unknown as EntityRow },
            { entityChange: ec("notes", noteId, "2098-01-01 00:00:01.000Z"), entity: noteRow(noteId, { blobId, title: "Renamed on the Mac" }) }
        ]);
        expect(received.map((e) => e.kind)).toEqual([ "note.content" ]);
        expect(received[0]?.blobId).toBe(blobId);

        received = [];
        apply([ { entityChange: ec("notes", noteId, "2098-01-01 00:00:02.000Z"), entity: noteRow(noteId, { isDeleted: 1, deleteId: "d1" }) } ]);
        expect(received.map((e) => [ e.kind, e.noteId ])).toEqual([ [ "note.deleted", noteId ] ]);
    });

    it("says created for a note the engine did not have", () => {
        const noteId = createNote();
        const row = noteRow(noteId, { noteId: `tfnew${counter}`, title: "From the Mac" });
        apply([ { entityChange: ec("notes", String((row as { noteId: string }).noteId)), entity: row } ]);
        expect(received.map((e) => [ e.kind, e.title ])).toEqual([ [ "note.created", "From the Mac" ] ]);
    });
});

function createNote(): string {
    counter++;
    return cls.init(() => notes.createNewNote({ parentNoteId: "root", title: `tf-sync-${counter}`, content: "<p>x</p>", type: "text" }).note.noteId);
}

function noteRow(noteId: string, extra: Record<string, unknown>): EntityRow {
    const row = getSql().getRowOrNull<EntityRow>("SELECT * FROM notes WHERE noteId = ?", [ noteId ]);
    if (!row) {
        throw new Error(`no note row ${noteId}`);
    }
    return { ...row, ...extra } as unknown as EntityRow;
}

function ec(entityName: string, entityId: string, utcDateChanged = NOW_ISH): EntityChange {
    return { entityName, entityId, hash: `remote-${entityId}`, isErased: false, isSynced: true, utcDateChanged, changeId: `c${counter}${entityName}${utcDateChanged}` } as EntityChange;
}

function apply(records: { entityChange: EntityChange; entity: EntityRow }[]) {
    cls.init(() => {
        setTfUser({ id: "laurie", name: "Laurie", role: "edit" });
        syncUpdateService.updateEntities(records, "desktopInst");
    });
    expect(becca.loaded).toBe(true);
}
