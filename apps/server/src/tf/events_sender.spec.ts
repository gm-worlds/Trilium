import type { TfEvent } from "@triliumnext/core/src/tf/index.js";
import { describe, expect, it, vi } from "vitest";

import { coalesceTfEvents, TfEventSender } from "./events_sender.js";

function event(kind: TfEvent["kind"], noteId: string, extra: Partial<TfEvent> = {}): TfEvent {
    return { kind, noteId, userId: "u", userName: "U", at: "t", ...extra };
}

describe("TfEventSender", () => {
    it("coalesces repeats inside one batch", () => {
        const events = [
            event("note.created", "a"),
            event("note.title", "a"),
            event("note.content", "a"),
            event("note.content", "b", { blobId: "1" }),
            event("note.content", "b", { blobId: "2" }),
            event("revision.created", "b", { revisionId: "r1" }),
            event("revision.created", "b", { revisionId: "r2" })
        ];
        expect(coalesceTfEvents(events)).toEqual([
            event("note.created", "a"),
            event("note.content", "b", { blobId: "2" }),
            event("revision.created", "b", { revisionId: "r1" }),
            event("revision.created", "b", { revisionId: "r2" })
        ]);
    });

    it("batches events, retries a failed post and never throws to the caller", async () => {
        vi.useFakeTimers();
        try {
            const post = vi.fn<(url: string, body: string) => Promise<void>>()
                .mockRejectedValueOnce(new Error("down"))
                .mockResolvedValue(undefined);
            const sender = new TfEventSender("http://receiver", post, 1000);

            sender.push(event("note.content", "a"));
            sender.push(event("note.deleted", "b"));
            expect(post).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(300);
            expect(post).toHaveBeenCalledTimes(2);
            expect(JSON.parse(post.mock.calls[1][1]).events.map((e: TfEvent) => e.kind)).toEqual([ "note.content", "note.deleted" ]);

            sender.push(event("note.title", "c"));
            await vi.advanceTimersByTimeAsync(100);
            expect(post).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(1000);
            expect(post).toHaveBeenCalledTimes(3);

            const quiet = new TfEventSender("", post);
            quiet.push(event("note.title", "c"));
            await vi.advanceTimersByTimeAsync(2000);
            expect(post).toHaveBeenCalledTimes(3);
        } finally {
            vi.useRealTimers();
        }
    });
});
