/**
 * Who is asking, when the engine runs embedded in Taskforce (`TF_EMBED=1`).
 *
 * The gateway in front of the engine authenticates the person and passes them on as `x-tf-*`
 * headers. The host (`apps/server/src/tf/request_context.ts`) copies those into the execution
 * context of each request; core reads them back through {@link getTfUser}. Nothing here reads the
 * environment, so the module also loads in standalone's worker, where it stays inert.
 */
import * as cls from "../services/context.js";

export type TfRole = "edit" | "view";

export interface TfUser {
    id: string;
    name: string;
    role: TfRole;
}

const USER_KEY = "tfUser";
const ROUTE_KEY = "tfRoute";

/** User ids end up inside option names (`tfu.<id>.<name>`), so they are kept to a safe alphabet. */
export const TF_USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

let embedded = false;

/** Turns the embedded behaviour on. Called once by the host when `TF_EMBED=1`. */
export function enableTfEmbed(on = true) {
    embedded = on;
}

export function isTfEmbedded() {
    return embedded;
}

/** The person behind the current request, or `null` outside a request or when not embedded. */
export function getTfUser(): TfUser | null {
    if (!embedded) {
        return null;
    }

    try {
        return cls.get<TfUser>(USER_KEY) ?? null;
    } catch {
        // No execution context has been initialised (early start-up).
        return null;
    }
}

export function getTfUserId(): string | null {
    return getTfUser()?.id ?? null;
}

export function isTfViewer(): boolean {
    return getTfUser()?.role === "view";
}

/** Stores the person in the current execution context. Requires an active `cls.init()` scope. */
export function setTfUser(user: TfUser | null) {
    cls.set(USER_KEY, user);
}

/** The registered route pattern (`/api/notes/:noteId/undelete`) of the current request, if any. */
export function getTfRoute(): string | null {
    try {
        return cls.get<string>(ROUTE_KEY) ?? null;
    } catch {
        return null;
    }
}

export function setTfRoute(route: string | null) {
    cls.set(ROUTE_KEY, route);
}

/**
 * Parses the identity headers the gateway adds. Returns `null` when no user id is present and
 * throws when one is present but malformed, so a bad header never reaches an option name.
 */
export function parseTfIdentityHeaders(headers: Record<string, string | string[] | undefined>): TfUser | null {
    const id = firstHeader(headers["x-tf-user-id"]);
    if (!id) {
        return null;
    }

    if (!TF_USER_ID_PATTERN.test(id)) {
        throw new Error("Malformed x-tf-user-id header.");
    }

    let name = firstHeader(headers["x-tf-user-name"]) ?? "";
    try {
        name = decodeURIComponent(name);
    } catch {
        // Keeps the raw value when the gateway sent something that is not URI-encoded.
    }

    const role: TfRole = firstHeader(headers["x-tf-role"]) === "edit" ? "edit" : "view";

    return { id, name: name || id, role };
}

function firstHeader(value: string | string[] | undefined) {
    return Array.isArray(value) ? value[0] : value;
}
