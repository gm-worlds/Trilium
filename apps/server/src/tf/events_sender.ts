/**
 * Batches the change events from `@triliumnext/core/src/tf/events.ts` and posts them to
 * `TF_EVENTS_URL` at most once a second. Sending runs on a timer outside any request, so a slow or
 * missing receiver never delays or fails a save; a failed post is retried a few times, then dropped.
 */
import type { TfEvent } from "@triliumnext/core/src/tf/index.js";

import { getTfGatewayKey } from "./env.js";

const FLUSH_INTERVAL_MS = 1000;
const MAX_ATTEMPTS = 3;
const MAX_QUEUE = 5000;
const REQUEST_TIMEOUT_MS = 5000;

type Poster = (url: string, body: string) => Promise<void>;

export class TfEventSender {
    private queue: TfEvent[] = [];
    private timer: ReturnType<typeof setTimeout> | null = null;
    private sending = false;
    private lastFlushAt = 0;

    constructor(
        private readonly url: string,
        private readonly post: Poster = (target, body) => postJson(target, body),
        private readonly intervalMs = FLUSH_INTERVAL_MS
    ) {}

    push(event: TfEvent) {
        if (!this.url) {
            return;
        }

        this.queue.push(event);
        if (this.queue.length > MAX_QUEUE) {
            this.queue.splice(0, this.queue.length - MAX_QUEUE);
        }
        this.schedule();
    }

    /** Sends whatever is queued now. Resolves once the batch is sent or given up on. */
    async flush() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.sending || this.queue.length === 0) {
            return;
        }

        this.sending = true;
        this.lastFlushAt = Date.now();
        const events = coalesceTfEvents(this.queue.splice(0));
        const body = JSON.stringify({ events });

        try {
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                try {
                    await this.post(this.url, body);
                    break;
                } catch (e) {
                    if (attempt === MAX_ATTEMPTS) {
                        console.warn(`Dropped ${events.length} Taskforce events: ${e instanceof Error ? e.message : e}`);
                    } else {
                        await delay(250 * attempt);
                    }
                }
            }
        } finally {
            this.sending = false;
            if (this.queue.length > 0) {
                this.schedule();
            }
        }
    }

    private schedule() {
        if (this.timer || this.sending) {
            return;
        }
        const wait = Math.max(0, this.lastFlushAt + this.intervalMs - Date.now());
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.flush();
        }, wait);
        this.timer.unref?.();
    }
}

/**
 * Removes repeats inside one batch: the same kind for the same note keeps its last occurrence, and
 * a title or content change of a note created in the same batch is part of the creation.
 */
export function coalesceTfEvents(events: TfEvent[]): TfEvent[] {
    const created = new Set(events.filter((e) => e.kind === "note.created").map((e) => e.noteId));
    const lastIndex = new Map<string, number>();

    for (const [index, event] of events.entries()) {
        lastIndex.set(coalesceKey(event), index);
    }

    return events.filter((event, index) => {
        if ((event.kind === "note.title" || event.kind === "note.content") && created.has(event.noteId)) {
            return false;
        }
        return lastIndex.get(coalesceKey(event)) === index;
    });
}

function coalesceKey(event: TfEvent) {
    // Revisions are distinct entities, so each one is reported.
    if (event.kind === "revision.created") {
        return `${event.kind}|${event.revisionId}`;
    }
    return `${event.kind}|${event.noteId}`;
}

/**
 * Posts one batch. The gateway takes a batch only from loopback with the key of the notebook's
 * running engine, so a script in one notebook cannot post events for another.
 */
export async function postJson(url: string, body: string, gatewayKey = getTfGatewayKey()) {
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tf-gateway-key": gatewayKey },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
