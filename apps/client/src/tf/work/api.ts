/**
 * Calls of the work features: Taskforce routes through the gateway (`/__tf/api/…`, see
 * `infra/notes/README.md` in Taskforce, "Feature routes") and the engine's own `/api/tf/*` routes.
 */
import { fetchWithRefresh, tfFetch } from "../gateway.js";
import { getTfClientId, TF_CLIENT_ID_HEADER } from "../save_guard.js";

export interface TfPerson {
    id: string;
    name: string;
    avatar: string | null;
    color: string;
}

export interface TfReminder {
    id: string;
    noteId: string;
    blockId: string | null;
    text: string;
    dueAt: string;
    snoozedUntil: string | null;
    doneAt: string | null;
    notifiedAt: string | null;
    user: TfPerson | null;
    createdBy: TfPerson | null;
    createdAt: string;
}

export interface TfTaskChip {
    ok: true;
    kind: "task";
    id: string;
    title: string;
    status: string;
    statusLabel: string;
    statusColor: string;
    done: boolean;
    assignee: { id: string; name: string; avatar: string | null } | null;
    dueAt: string | null;
    href: string;
}

export type TfChipResult =
    | TfTaskChip
    | { ok: true; kind: "project"; id: string; title: string; projectKind: string; href: string }
    | { ok: true; kind: "document"; id: string; title: string; docKind: string; projectId: string; href: string }
    | { ok: true; kind: "note"; id: string; notebookId: string; noteId: string; title: string; notebookName: string; href: string }
    | { ok: false; reason: "not_found" | "no_access" };

export interface TfTodoItem {
    noteId: string;
    noteTitle: string;
    notePath: string[];
    blockId: string | null;
    index: number;
    text: string;
    state: string;
    stateTitle: string | null;
    checked: boolean;
    completed: boolean;
}

export interface TfTodoNote {
    noteId: string;
    noteTitle: string;
    notePath: string[];
    blobId: string;
}

export interface TfTodoList {
    items: TfTodoItem[];
    notes: TfTodoNote[];
    total: number;
    next: string | null;
}

export class TfEngineError extends Error {
    constructor(readonly status: number, readonly body: unknown) {
        super(`Engine answered ${status}`);
        this.name = "TfEngineError";
    }
}

let peopleCache: Promise<TfPerson[]> | null = null;

/** Who may open the notebook's project, once per session. */
export function getPeople(): Promise<TfPerson[]> {
    if (!peopleCache) {
        peopleCache = tfFetch<{ people: TfPerson[] }>("people")
            .then((answer) => answer.people ?? [])
            .catch((e) => {
                peopleCache = null;
                throw e;
            });
    }
    return peopleCache;
}

export const reminders = {
    forNote: (noteId: string) => tfFetch<{ reminders: TfReminder[] }>(`reminders?noteId=${encodeURIComponent(noteId)}`).then((a) => a.reminders),
    mine: () => tfFetch<{ reminders: TfReminder[] }>("reminders?mine=1").then((a) => a.reminders),
    create: (body: { noteId: string; blockId?: string; dueAt: string; text: string; userId?: string }) =>
        tfFetch<{ reminder: TfReminder }>("reminders", { json: body }).then((a) => a.reminder),
    update: (id: string, body: { dueAt?: string; snoozedUntil?: string | null; doneAt?: string | null; text?: string }) =>
        tfFetch<{ reminder: TfReminder }>(`reminders/${encodeURIComponent(id)}`, { method: "PATCH", json: body }).then((a) => a.reminder),
    remove: (id: string) => tfFetch<{ ok: true }>(`reminders/${encodeURIComponent(id)}`, { method: "DELETE" })
};

export const tasks = {
    /** `requestId` makes a repeated request (a double press, a retry) answer the task the first one made. */
    create: (body: { requestId: string; noteId: string; blockId?: string; title: string; excerpt?: string; noteTitle?: string; assigneeId?: string; dueAt?: string }) =>
        tfFetch<{ chip: TfTaskChip; linkId: string }>("tasks", { json: body }),
    forNote: (noteId: string) =>
        tfFetch<{ tasks: { linkId: string; noteId: string; blockId: string | null; chip: TfTaskChip }[] }>(`tasks?noteId=${encodeURIComponent(noteId)}`).then((a) => a.tasks),
    setDone: (taskId: string, done: boolean) =>
        tfFetch<{ chip: TfTaskChip }>(`tasks/${encodeURIComponent(taskId)}`, { method: "PATCH", json: { done } }).then((a) => a.chip)
};

export function resolveLinks(urls: string[]): Promise<TfChipResult[]> {
    return tfFetch<{ results: TfChipResult[] }>("links/resolve", { json: { refs: urls.map((url) => ({ url })) } }).then((a) => a.results);
}

export const todos = {
    list: (params: { scope: "notebook" | "subtree"; noteId?: string; state?: "open" | "all"; cursor?: string }) => {
        const query = new URLSearchParams({ scope: params.scope, state: params.state ?? "open", limit: "500" });
        if (params.noteId) {
            query.set("noteId", params.noteId);
        }
        if (params.cursor) {
            query.set("cursor", params.cursor);
        }
        return engineFetch<TfTodoList>(`api/tf/todos?${query.toString()}`);
    },
    toggle: (body: { noteId: string; blockId?: string | null; index: number; checked?: boolean; state?: string; baseBlobId: string }) =>
        engineFetch<{ blobId: string; item: TfTodoItem }>("api/tf/todos/toggle", { method: "POST", json: body })
};

/** An engine API call with the page's CSRF token; throws {@link TfEngineError} on an error status. */
async function engineFetch<T>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json", [TF_CLIENT_ID_HEADER]: getTfClientId() };
    const csrf = (window.glob as { csrfToken?: string } | undefined)?.csrfToken;
    if (csrf) {
        headers["x-csrf-token"] = csrf;
    }
    if (init.json !== undefined) {
        headers["Content-Type"] = "application/json";
    }
    const response = await fetchWithRefresh(() => fetch(path, {
        method: init.method ?? "GET",
        credentials: "same-origin",
        headers,
        body: init.json !== undefined ? JSON.stringify(init.json) : undefined
    }));
    const text = await response.text();
    let body: unknown = null;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        body = text;
    }
    if (!response.ok) {
        throw new TfEngineError(response.status, body);
    }
    return body as T;
}
