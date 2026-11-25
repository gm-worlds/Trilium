/**
 * The connect link Taskforce hands out for a notebook:
 * `taskforce-notes://connect?server=<notebook origin>&code=<pair code>`.
 */
import { TF_URL_SCHEME } from "./flavour";

export interface TfConnectLink {
    /** The notebook's origin (`https://nb-….example`), without a path or a trailing slash. */
    server: string;
    /** The single-use pair code: 32 characters of base32. */
    code: string;
}

const CODE_PATTERN = /^[A-Z2-7]{32}$/;

/**
 * Reads a connect link as pasted or opened: surrounding whitespace and quotes, upper or lower case
 * scheme and code, and a `/` after `connect` are tolerated. The server must be `https`, or `http`
 * on a loopback address (local tests); anything that is not a bare origin is refused, so a link
 * cannot point the device key at a path of another site.
 */
export function parseConnectLink(raw: string): TfConnectLink | null {
    const text = raw.trim().replace(/^["'<]+|["'>]+$/g, "");
    let url: URL;
    try {
        url = new URL(text);
    } catch {
        return null;
    }
    if (url.protocol.toLowerCase() !== `${TF_URL_SCHEME}:`) {
        return null;
    }
    // `taskforce-notes://connect?…` parses with host "connect"; `taskforce-notes:connect?…` with that pathname.
    const target = (url.host || url.pathname.replace(/^\/+/, "")).replace(/\/+$/, "").toLowerCase();
    if (target !== "connect") {
        return null;
    }

    const code = (url.searchParams.get("code") ?? "").trim().toUpperCase();
    const server = normalizeServerOrigin(url.searchParams.get("server") ?? "");
    if (!server || !CODE_PATTERN.test(code)) {
        return null;
    }
    return { server, code };
}

/** The origin of a notebook address, or `null` when it is not an allowed one. */
export function normalizeServerOrigin(raw: string): string | null {
    let server: URL;
    try {
        server = new URL(raw.trim());
    } catch {
        return null;
    }
    if (server.username || server.password || server.search || server.hash) {
        return null;
    }
    if (server.pathname !== "/" && server.pathname !== "") {
        return null;
    }
    if (server.protocol === "https:") {
        return server.origin;
    }
    if (server.protocol === "http:" && isLoopbackHost(server.hostname)) {
        return server.origin;
    }
    return null;
}

/** Whether two notebook addresses name the same origin. */
export function isSameServer(a: string, b: string) {
    const left = normalizeServerOrigin(a);
    return left !== null && left === normalizeServerOrigin(b);
}

function isLoopbackHost(hostname: string) {
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
