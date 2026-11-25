/**
 * WebSocket side of the embedding: refuses upgrades without the gateway key, remembers who each
 * socket belongs to, and gives each person their own view of option changes in `frontend-update`
 * messages (see `filterTfEntityChangesForUser()`).
 */
import type { WebSocketMessage } from "@triliumnext/commons";
import { applyTfExpansionToEntityChanges, filterTfEntityChangesForUser, isTfEmbedded } from "@triliumnext/core/src/tf/index.js";
import type { IncomingMessage } from "http";
import type { WebSocket } from "ws";

import { getTfRequestUser, verifyTfUpgrade } from "./request_context.js";

const socketUsers = new WeakMap<WebSocket, string | null>();

/** `true` when the upgrade may go ahead; always `true` outside embed mode. */
export function allowTfUpgrade(req: IncomingMessage) {
    return !isTfEmbedded() || verifyTfUpgrade(req);
}

export function tagTfSocket(ws: WebSocket, req: IncomingMessage) {
    if (isTfEmbedded()) {
        socketUsers.set(ws, getTfRequestUser(req)?.id ?? null);
    }
}

/**
 * The JSON to send to one socket: `jsonStr` unchanged unless it carries option or branch changes.
 * Branch rows get the socket owner's own expansion (`applyTfExpansionToEntityChanges()`).
 */
export function tfMessageForSocket(ws: WebSocket, message: WebSocketMessage, jsonStr: string) {
    if (!isTfEmbedded() || message.type !== "frontend-update") {
        return jsonStr;
    }

    const { entityChanges } = message.data;
    if (!entityChanges.some((change) => change.entityName === "options" || change.entityName === "branches")) {
        return jsonStr;
    }

    const userId = socketUsers.get(ws) ?? null;
    // Works on a parsed copy: the entities are becca objects, which stay as they are for the next socket.
    const copy = JSON.parse(jsonStr) as Extract<WebSocketMessage, { type: "frontend-update" }>;
    const filtered = applyTfExpansionToEntityChanges(filterTfEntityChangesForUser(copy.data.entityChanges, userId), userId);
    return JSON.stringify({ ...copy, data: { ...copy.data, entityChanges: filtered } });
}
