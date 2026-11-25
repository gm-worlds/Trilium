import type { EntityChange, WebSocketMessage } from "@triliumnext/commons";
import { cls, options } from "@triliumnext/core";
import { enableTfEmbed } from "@triliumnext/core/src/tf/index.js";
import type { IncomingMessage } from "http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";

import { allowTfUpgrade, tagTfSocket, tfMessageForSocket } from "./ws.js";

function upgradeRequest(headers: Record<string, string>) {
    return { headers } as unknown as IncomingMessage;
}

function optionChange(name: string, value: string): EntityChange {
    return {
        id: 1,
        entityName: "options",
        entityId: name,
        entity: { name, value },
        hash: "h",
        utcDateChanged: "2026-01-01",
        isSynced: false,
        isErased: false,
        componentId: "c",
        changeId: "x",
        instanceId: "i"
    } as unknown as EntityChange;
}

describe("Taskforce WebSocket filtering", () => {
    beforeAll(() => {
        process.env.TF_GATEWAY_KEY = "ws-key";
        enableTfEmbed(true);
        cls.init(() => options.createOption("tfu.alice.theme" as "theme", "next-dark", false));
        cls.init(() => options.createOption("tfu.alice.tfTreeExpanded" as "theme", JSON.stringify({ b1: 1, b2: 0 }), false));
    });

    afterAll(() => {
        enableTfEmbed(false);
    });

    it("refuses an upgrade without the gateway key", () => {
        expect(allowTfUpgrade(upgradeRequest({}))).toBe(false);
        expect(allowTfUpgrade(upgradeRequest({ "x-tf-gateway-key": "nope" }))).toBe(false);
        expect(allowTfUpgrade(upgradeRequest({ "x-tf-gateway-key": "ws-key", "x-tf-user-id": "bad id" }))).toBe(false);
        expect(allowTfUpgrade(upgradeRequest({ "x-tf-gateway-key": "ws-key", "x-tf-user-id": "alice" }))).toBe(true);
    });

    it("sends each socket its own options and nobody else's", () => {
        const sockets: Record<string, WebSocket> = {};
        for (const id of [ "alice", "bob" ]) {
            const req = upgradeRequest({ "x-tf-gateway-key": "ws-key", "x-tf-user-id": id, "x-tf-role": "edit" });
            expect(allowTfUpgrade(req)).toBe(true);
            sockets[id] = {} as WebSocket;
            tagTfSocket(sockets[id], req);
        }

        const message: WebSocketMessage = {
            type: "frontend-update",
            data: {
                lastSyncedPush: 0,
                entityChanges: [
                    optionChange("tfu.alice.openNoteContexts", "[alice tabs]"),
                    optionChange("tfu.bob.openNoteContexts", "[bob tabs]"),
                    optionChange("theme", "next-light"),
                    { ...optionChange("x", "y"), entityName: "notes", entityId: "n1" }
                ]
            }
        };
        const json = JSON.stringify(message);

        const forAlice = JSON.parse(tfMessageForSocket(sockets.alice, message, json));
        const forBob = JSON.parse(tfMessageForSocket(sockets.bob, message, json));

        // Alice has her own theme, so the shared theme change is not hers.
        expect(forAlice.data.entityChanges.map((c: EntityChange) => [ c.entityId, c.entity?.value ])).toEqual([
            [ "openNoteContexts", "[alice tabs]" ],
            [ "n1", "y" ]
        ]);
        expect(forAlice.data.entityChanges[0].entity.name).toBe("openNoteContexts");
        expect(forBob.data.entityChanges.map((c: EntityChange) => [ c.entityId, c.entity?.value ])).toEqual([
            [ "openNoteContexts", "[bob tabs]" ],
            [ "theme", "next-light" ],
            [ "n1", "y" ]
        ]);

        const ping: WebSocketMessage = { type: "ping" };
        expect(tfMessageForSocket(sockets.alice, ping, "same")).toBe("same");
    });

    it("gives branch rows each person's own expansion and keeps tree state rows on the server", () => {
        const sockets: Record<string, WebSocket> = {};
        for (const id of [ "alice", "bob" ]) {
            const req = upgradeRequest({ "x-tf-gateway-key": "ws-key", "x-tf-user-id": id, "x-tf-role": "edit" });
            expect(allowTfUpgrade(req)).toBe(true);
            sockets[id] = {} as WebSocket;
            tagTfSocket(sockets[id], req);
        }
        const branch = (branchId: string, isExpanded: boolean) => ({
            ...optionChange("x", "y"), entityName: "branches", entityId: branchId,
            entity: { branchId, noteId: "n", parentNoteId: "root", isExpanded }
        }) as EntityChange;

        const message: WebSocketMessage = {
            type: "frontend-update",
            data: {
                lastSyncedPush: 0,
                entityChanges: [ branch("b1", false), branch("b2", true), branch("b3", true),
                    optionChange("tfu.alice.tfTreeExpanded", "{}") ]
            }
        };
        const json = JSON.stringify(message);
        const rows = (socket: WebSocket) => (JSON.parse(tfMessageForSocket(socket, message, json)).data.entityChanges as EntityChange[])
            .map((c) => [ c.entityId, (c.entity as { isExpanded?: boolean } | undefined)?.isExpanded ]);

        expect(rows(sockets.alice)).toEqual([ [ "b1", true ], [ "b2", false ], [ "b3", true ] ]);
        expect(rows(sockets.bob)).toEqual([ [ "b1", false ], [ "b2", true ], [ "b3", true ] ]);
        expect(message.data.entityChanges[0].entity).toMatchObject({ isExpanded: false });
    });
});
