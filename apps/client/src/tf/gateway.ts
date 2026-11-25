/**
 * Calls to the notes gateway in front of the engine: `/__tf/api/*` (Taskforce API routes passed
 * through by the gateway) and the `/__tf/rt` realtime socket.
 *
 * A 401 means the gateway session ran out. The frame then asks the host for a new token
 * (`session.expired`), waits for `session.refresh`, posts the token to `/__tf/refresh` and retries
 * the request once.
 */
import { getTfBridge } from "./bridge.js";

export class TfGatewayError extends Error {
    constructor(readonly status: number, readonly body: unknown) {
        super(`Gateway answered ${status}`);
        this.name = "TfGatewayError";
    }
}

let refreshWaiters: ((ok: boolean) => void)[] = [];
let refreshInFlight: Promise<boolean> | null = null;
const SESSION_REFRESH_TIMEOUT_MS = 30_000;

/** Fetches `/__tf/api/<path>`. Sends and parses JSON; throws {@link TfGatewayError} on an error status. */
export async function tfFetch<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
    const response = await fetchWithRefresh(() => fetch(`/__tf/api/${path.replace(/^\/+/, "")}`, buildInit(init)));
    const body = await readBody(response);
    if (!response.ok) {
        throw new TfGatewayError(response.status, body);
    }
    return body as T;
}

/**
 * Runs `doFetch`, and after a 401 renews the gateway session once and runs it again. Also used by
 * the engine API calls in `save_guard.ts`.
 */
export async function fetchWithRefresh(doFetch: () => Promise<Response>): Promise<Response> {
    const response = await doFetch();
    if (response.status !== 401) {
        return response;
    }
    return (await renewSession()) ? doFetch() : response;
}

/**
 * Asks the host for a new session token and resolves `true` once the gateway accepted it. Several
 * callers that hit a 401 at the same time share one renewal.
 */
export function renewSession(): Promise<boolean> {
    if (refreshInFlight) {
        return refreshInFlight;
    }

    const bridge = getTfBridge();
    if (!bridge) {
        return Promise.resolve(false);
    }

    refreshInFlight = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => settleRefresh(false), SESSION_REFRESH_TIMEOUT_MS);
        refreshWaiters.push((ok) => {
            clearTimeout(timer);
            resolve(ok);
        });
        bridge.notify("session.expired", {});
    }).finally(() => {
        refreshInFlight = null;
    });
    return refreshInFlight;
}

/** Handles the host's `session.refresh`: hands the token to the gateway, then wakes the waiters. */
export async function applySessionRefresh(token: string) {
    let ok = false;
    try {
        const response = await fetch("/__tf/refresh", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token })
        });
        ok = response.ok;
    } catch {
        ok = false;
    }
    settleRefresh(ok);
    return { ok };
}

function settleRefresh(ok: boolean) {
    const waiters = refreshWaiters;
    refreshWaiters = [];
    for (const waiter of waiters) {
        waiter(ok);
    }
}

type RealtimeListener = (data: any) => void;

export interface TfRealtime {
    on(event: string, listener: RealtimeListener): () => void;
    send(event: string, data?: unknown): void;
    close(): void;
}

let realtime: TfRealtime | null = null;

/** The shared realtime connection to `/__tf/rt`; it reconnects with back-off after a drop. */
export function tfRealtime(): TfRealtime {
    if (!realtime) {
        realtime = createRealtime(() => {
            const scheme = location.protocol === "https:" ? "wss:" : "ws:";
            return new WebSocket(`${scheme}//${location.host}/__tf/rt`);
        });
    }
    return realtime;
}

export function createRealtime(openSocket: () => WebSocket): TfRealtime {
    const listeners = new Map<string, Set<RealtimeListener>>();
    const outbox: string[] = [];
    let socket: WebSocket | null = null;
    let attempt = 0;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    /** Also fires `__open` after each (re)connect and `__close` after each drop, for state to resend or clear. */
    function emit(event: string, data: unknown) {
        for (const listener of listeners.get(event) ?? []) {
            listener(data);
        }
    }

    function connect() {
        if (closed) {
            return;
        }
        socket = openSocket();
        socket.onopen = () => {
            attempt = 0;
            for (const frame of outbox.splice(0)) {
                socket?.send(frame);
            }
            emit("__open", {});
        };
        socket.onmessage = (event) => {
            let frame: { event?: string; data?: unknown };
            try {
                frame = JSON.parse(String(event.data));
            } catch {
                return;
            }
            if (!frame.event) {
                return;
            }
            emit(frame.event, frame.data);
        };
        socket.onclose = () => {
            socket = null;
            if (closed) {
                return;
            }
            emit("__close", {});
            attempt++;
            const delay = Math.min(1000 * 2 ** Math.min(attempt - 1, 5), 30_000);
            reconnectTimer = setTimeout(connect, delay);
        };
    }

    connect();

    return {
        on(event, listener) {
            let set = listeners.get(event);
            if (!set) {
                set = new Set();
                listeners.set(event, set);
            }
            set.add(listener);
            return () => set?.delete(listener);
        },
        send(event, data = {}) {
            const frame = JSON.stringify({ event, data });
            if (socket?.readyState === WebSocket.OPEN) {
                socket.send(frame);
            } else {
                outbox.push(frame);
            }
        },
        close() {
            closed = true;
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
            }
            socket?.close();
        }
    };
}

function buildInit(init: RequestInit & { json?: unknown }): RequestInit {
    const { json, headers, ...rest } = init;
    const result: RequestInit = { credentials: "same-origin", ...rest };
    const allHeaders = new Headers(headers);
    if (json !== undefined) {
        allHeaders.set("Content-Type", "application/json");
        result.body = JSON.stringify(json);
        result.method = rest.method ?? "POST";
    }
    allHeaders.set("Accept", "application/json");
    result.headers = allHeaders;
    return result;
}

async function readBody(response: Response) {
    const text = await response.text();
    if (!text) {
        return null;
    }
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}
