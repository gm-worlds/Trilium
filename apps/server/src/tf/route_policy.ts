/**
 * Routes an embedded engine never answers, whoever asks, and routes a viewer may not call.
 *
 * The gateway in front blocks the same prefixes, but the engine does not rely on it. Matching runs
 * on the canonical path: every segment decoded, lower case (Express routes ignore case), duplicate
 * and trailing slashes removed. A path with a `.` or `..` segment, an empty segment inside it, an
 * encoded slash or backslash before its last segment, or a broken escape is refused outright.
 * The last segment may hold an encoded slash, as image URLs carry the note title there; it is
 * split like any other separator before matching.
 */

/**
 * Prefixes answered with 404 for every role. A trailing `*` matches any continuation
 * (`/api/totp*` covers `/api/totp_recovery/...`); without it the prefix matches itself and the
 * paths below it.
 */
export const TF_REFUSED_ROUTE_PREFIXES: readonly string[] = [
    "/api/database",
    "/api/sql",
    "/api/backend-log",
    "/api/backup*",
    "/api/etapi-tokens*",
    "/etapi",
    "/mcp*",
    "/api/sync",
    "/api/setup",
    "/api/password",
    "/api/login",
    "/api/totp*",
    "/api/oauth*",
    "/api/clipper",
    "/api/sender",
    "/api/llm*",
    "/api/special-notes/llm-chat",
    "/api/special-notes/save-llm-chat",
    "/api/special-notes/most-recent-llm-chat",
    "/api/special-notes/recent-llm-chats",
    "/api/resources",
    "/api/onenote-import",
    "/api/network-addresses",
    "/api/metrics"
];

/**
 * Exceptions to {@link TF_REFUSED_ROUTE_PREFIXES} for the edit role (and requests without a
 * person); a viewer gets 403 `{ tfReadOnly: true }`. `POST /api/password/change` sets the
 * notebook's password for protected notes when it has none and otherwise needs the current one.
 */
export const TF_EDITOR_ROUTES: ReadonlySet<string> = new Set([ "/api/password/change" ]);

/** Exceptions to {@link TF_REFUSED_ROUTE_PREFIXES}: the protected session stays available. */
export const TF_ALLOWED_ROUTES: ReadonlySet<string> = new Set([
    "/api/login/protected",
    "/api/login/protected/touch"
]);

/**
 * Routes a viewer may not call (403 `{ tfReadOnly: true }`), matched on the canonical path. They run
 * scripts, which can write past the entity guard (bulk actions include `executeScript`), erase rows
 * without an entity change, or report a refused write as success or as a failed import.
 */
export const TF_VIEWER_REFUSED_ROUTES: readonly RegExp[] = [
    /^\/api\/script\/(exec|run)(\/|$)/,
    /^\/api\/search-and-execute-note(\/|$)/,
    /^\/api\/bulk-action\/execute$/,
    /^\/api\/notes\/(erase-deleted-notes-now|erase-unused-attachments-now)$/,
    /^\/api\/revisions\/erase-all-excess-revisions$/,
    /^\/api\/notes\/[^/]+\/(notes-import|attachments-import|attachments\/upload)$/
];

export type TfRouteDecision = "allow" | "refuse" | "read-only";

/** The canonical form of the path of `url` (query and fragment dropped), or `null` when it is malformed. */
export function canonicalTfPath(url: string): string | null {
    const rawPath = url.split(/[?#]/, 1)[0] ?? "";
    if (!rawPath.startsWith("/") || rawPath.includes("\\")) {
        return null;
    }

    const rawSegments = rawPath.substring(1).split("/");
    if (rawSegments.length > 1 && rawSegments.at(-1) === "") {
        rawSegments.pop();
    }

    const parts: string[] = [];
    for (const [ index, raw ] of rawSegments.entries()) {
        const isLast = index === rawSegments.length - 1;
        if (raw === "" && !(isLast && rawSegments.length === 1)) {
            return null;
        }

        let decoded: string;
        try {
            decoded = decodeURIComponent(raw);
        } catch {
            return null;
        }
        if (decoded.includes("\0")) {
            return null;
        }

        const pieces = decoded.split(/[/\\]/);
        if (pieces.length > 1 && !isLast) {
            return null;
        }
        for (const piece of pieces) {
            if (piece === "." || piece === "..") {
                return null;
            }
            if (piece !== "") {
                parts.push(piece.toLowerCase());
            }
        }
    }

    return `/${parts.join("/")}`;
}

/**
 * Routes of a refused family that the gateway itself calls, with its key and no person: it
 * asks whether a new notebook's database exists and makes the empty document. A request that
 * carries a person (everything the gateway passes on from a browser does) never reaches them.
 */
export const TF_GATEWAY_ONLY_ROUTES = new Set([ "/api/setup/status", "/api/setup/new-document" ]);

/**
 * What an embedded engine does with a request for `url` from someone with `role`; `null` is
 * the gateway's own call, without a person.
 */
export function decideTfRoute(url: string, role: "edit" | "view" | null): TfRouteDecision {
    const path = canonicalTfPath(url);
    if (path === null) {
        return "refuse";
    }

    if (role === null && TF_GATEWAY_ONLY_ROUTES.has(path)) {
        return "allow";
    }

    if (TF_EDITOR_ROUTES.has(path)) {
        return role === "view" ? "read-only" : "allow";
    }

    if (!TF_ALLOWED_ROUTES.has(path) && TF_REFUSED_ROUTE_PREFIXES.some((prefix) => matchesPrefix(path, prefix))) {
        return "refuse";
    }

    if (role === "view" && TF_VIEWER_REFUSED_ROUTES.some((pattern) => pattern.test(path))) {
        return "read-only";
    }

    return "allow";
}

function matchesPrefix(path: string, prefix: string) {
    if (prefix.endsWith("*")) {
        return path.startsWith(prefix.slice(0, -1));
    }
    return path === prefix || path.startsWith(`${prefix}/`);
}
