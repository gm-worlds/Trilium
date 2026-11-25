/**
 * The `share-links` routes through the gateway, and the notice the dialog and the title row's
 * marker share when a note's links change.
 */
import { tfFetch, TfGatewayError } from "../../gateway.js";
import type { CreateBody, ShareLinkCreated, ShareLinkMeta } from "./model.js";

export async function listShareLinks(noteId: string) {
    const answer = await tfFetch<{ links: ShareLinkMeta[] }>(`share-links?noteId=${encodeURIComponent(noteId)}`);
    return Array.isArray(answer?.links) ? answer.links : [];
}

export async function createShareLink(body: CreateBody) {
    const created = await tfFetch<ShareLinkCreated>("share-links", { method: "POST", json: body });
    emitShareChanged(body.noteId);
    return created;
}

export async function patchShareLink(noteId: string, linkId: string, body: { expiresAt?: string | null; password?: string | null }) {
    const answer = await tfFetch<{ link: ShareLinkMeta }>(`share-links/${encodeURIComponent(linkId)}`, { method: "PATCH", json: body });
    emitShareChanged(noteId);
    return answer.link;
}

export async function withdrawShareLink(noteId: string, linkId: string) {
    const answer = await tfFetch<{ link: ShareLinkMeta; unshared: boolean }>(`share-links/${encodeURIComponent(linkId)}`, { method: "DELETE" });
    emitShareChanged(noteId);
    return answer;
}

/** The message of a failed call, for "That did not work: …". */
export function errorMessage(error: unknown) {
    if (error instanceof TfGatewayError) {
        const body = error.body as { message?: unknown; error?: unknown } | null;
        if (typeof body?.message === "string") return body.message;
        if (typeof body?.error === "string") return body.error.replace(/_/g, " ");
        return `HTTP ${error.status}`;
    }
    return error instanceof Error ? error.message : String(error);
}

const listeners = new Set<(noteId: string) => void>();

export function onShareChanged(listener: (noteId: string) => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function emitShareChanged(noteId: string) {
    for (const listener of listeners) {
        listener(noteId);
    }
}
