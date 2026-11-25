/**
 * Taskforce links in note text. Mirrors `parseTaskforceLink()` of Taskforce's
 * `packages/shared/src/notes.ts`, which the frame cannot import:
 *
 * | Link | Points at |
 * |---|---|
 * | `/p/<projectId>?task=<taskId>` (any other params) | task |
 * | `/p/<projectId>/d/<documentId>` | document |
 * | `/p/<projectId>?…&note=<noteId>` | note |
 * | `/p/<projectId>` | project |
 * | `<notebook origin>/#root/…/<noteId>` | note in that notebook |
 *
 * Only `http(s)` links on an app origin, a notebook origin, or relative links starting with `/`.
 */
export type TfLinkKind = "task" | "project" | "document" | "note";

export interface TfLinkRef {
    kind: TfLinkKind;
    /** Task, project or document id; `<notebookId>:<noteId>` or the note id for a note. */
    id: string;
    /** The link as stored in the note: absolute, on the app origin or the notebook's. */
    href: string;
}

export interface TfLinkConfig {
    /** Origins Taskforce is served from; the first one completes relative links. */
    appOrigins: string[];
    /** `http` or `https`. */
    notesScheme: string;
    /** `example.com` or `localhost:9779`. */
    notesBaseDomain: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTE_ID_RE = /^[A-Za-z0-9_]{1,64}$/;
const NOTEBOOK_ID_RE = /^[a-z2-7]{20}$/;

export function parseTaskforceLink(raw: string, cfg: TfLinkConfig): TfLinkRef | null {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 2000 || raw.startsWith("//")) {
        return null;
    }
    const base = cfg.appOrigins[0] ?? "http://taskforce.invalid";
    let url: URL;
    try {
        url = new URL(raw, base);
    } catch {
        return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return null;
    }

    const notebookId = notebookIdFromOrigin(url.origin, cfg);
    if (notebookId) {
        const hash = url.hash.replace(/^#/, "").split("?")[0] ?? "";
        const parts = hash.split("/").filter(Boolean);
        const noteId = parts[parts.length - 1];
        if (!noteId || !NOTE_ID_RE.test(noteId)) {
            return null;
        }
        return { kind: "note", id: `${notebookId}:${noteId}`, href: url.href };
    }

    const isApp = raw.startsWith("/") || cfg.appOrigins.includes(url.origin);
    if (!isApp) {
        return null;
    }
    const href = raw.startsWith("/") ? `${base.replace(/\/$/, "")}${raw}` : url.href;
    const match = /^\/p\/([0-9a-fA-F-]{36})(?:\/d\/([0-9a-fA-F-]{36}))?\/?$/.exec(url.pathname);
    if (!match || !UUID_RE.test(match[1])) {
        return null;
    }
    if (match[2]) {
        return UUID_RE.test(match[2]) ? { kind: "document", id: match[2].toLowerCase(), href } : null;
    }
    const task = url.searchParams.get("task");
    if (task) {
        return UUID_RE.test(task) ? { kind: "task", id: task.toLowerCase(), href } : null;
    }
    const note = url.searchParams.get("note");
    if (note) {
        return NOTE_ID_RE.test(note) ? { kind: "note", id: note, href } : null;
    }
    return { kind: "project", id: match[1].toLowerCase(), href };
}

/** The notebook id an origin belongs to, or `null`. */
export function notebookIdFromOrigin(origin: string, cfg: Pick<TfLinkConfig, "notesScheme" | "notesBaseDomain">): string | null {
    const prefix = `${cfg.notesScheme.replace(/:$/, "")}://nb-`;
    const suffix = `.${cfg.notesBaseDomain}`;
    if (!origin.startsWith(prefix) || !origin.endsWith(suffix)) {
        return null;
    }
    const id = origin.slice(prefix.length, origin.length - suffix.length);
    return NOTEBOOK_ID_RE.test(id) ? id : null;
}

/** The scheme and base domain of notebook origins, read from this frame's own `nb-<id>` origin. */
export function notesOriginConfig(location: Pick<Location, "protocol" | "host">): Pick<TfLinkConfig, "notesScheme" | "notesBaseDomain"> {
    const scheme = location.protocol.replace(/:$/, "");
    const host = location.host;
    const match = /^nb-[a-z2-7]{20}\.(.+)$/.exec(host);
    return { notesScheme: scheme, notesBaseDomain: match ? match[1] : host };
}

/** A Taskforce path for the host's `open` (`/p/…`), from an absolute app link; other links unchanged. */
export function toHostPath(href: string, appOrigins: string[]): string {
    if (href.startsWith("/")) {
        return href;
    }
    try {
        const url = new URL(href);
        if (appOrigins.includes(url.origin)) {
            return `${url.pathname}${url.search}${url.hash}`;
        }
    } catch {
        // Not a URL: handed over as it is.
    }
    return href;
}

/** An absolute link on the first app origin for a Taskforce path. */
export function toAbsoluteHref(href: string, appOrigins: string[]): string {
    if (!href.startsWith("/") || href.startsWith("//")) {
        return href;
    }
    const base = appOrigins[0];
    return base ? `${base.replace(/\/$/, "")}${href}` : href;
}
