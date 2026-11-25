import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDebouncedSearch, excerptToHtml, type NoteSearchHit, otherNotebookHits, SEARCH_DEBOUNCE_MS } from "./other_search.js";

const hit = (patch: Partial<NoteSearchHit>): NoteSearchHit => ({
    notebookId: "nb2", noteId: "n1", title: "Plan", path: "Root", excerpt: "", projectId: "p",
    projectName: "Launch", notebookName: "Notes", href: "/p/p?view=v&note=n1", ...patch
});

describe("other notebooks search", () => {
    it("escapes the excerpt and turns the API's markers into <mark>", () => {
        expect(excerptToHtml("a [[zebra]] <b>x</b> & \"q\" [[two]]"))
            .toBe("a <mark>zebra</mark> &lt;b&gt;x&lt;/b&gt; &amp; &quot;q&quot; <mark>two</mark>");
        expect(excerptToHtml("[[<img src=x onerror=alert(1)>]]")).toBe("<mark>&lt;img src=x onerror=alert(1)&gt;</mark>");
        expect(excerptToHtml("open [[ never closed")).toBe("open [[ never closed");
        expect(excerptToHtml("")).toBe("");
    });

    it("leaves the hits of this notebook to Trilium's own results", () => {
        const hits = [ hit({ noteId: "a", here: true }), hit({ noteId: "b" }), hit({ noteId: "c", href: "https://elsewhere" }) ];
        expect(otherNotebookHits(hits).map((h) => h.noteId)).toEqual([ "b" ]);
        expect(otherNotebookHits(null)).toEqual([]);
    });

    describe("debounce", () => {
        beforeEach(() => vi.useFakeTimers());
        afterEach(() => vi.useRealTimers());

        it("waits 250 ms after the last key, cancels older requests and needs two characters", async () => {
            const signals: AbortSignal[] = [];
            const fetcher = vi.fn(async (query: string, signal: AbortSignal) => {
                signals.push(signal);
                await new Promise((resolve) => setTimeout(resolve, 1000));
                return [ hit({ title: query }) ];
            });
            const seen: [string, string[]][] = [];
            const search = createDebouncedSearch(fetcher, (query, hits) => seen.push([ query, hits.map((h) => h.title) ]));

            search.update("z");
            expect(seen).toEqual([ [ "z", [] ] ]);
            search.update("ze");
            vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 10);
            search.update("zeb");
            vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 10);
            expect(fetcher).not.toHaveBeenCalled();
            vi.advanceTimersByTime(10);
            expect(fetcher).toHaveBeenCalledTimes(1);
            expect(fetcher).toHaveBeenLastCalledWith("zeb", expect.anything());

            search.update("zebr");
            expect(signals[0].aborted).toBe(true);
            vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
            await vi.advanceTimersByTimeAsync(1000);
            expect(seen.at(-1)).toEqual([ "zebr", [ "zebr" ] ]);
            expect(seen.some(([ q ]) => q === "zeb")).toBe(false);

            search.update("x");
            expect(seen.at(-1)).toEqual([ "x", [] ]);
        });

        it("shows nothing when the search fails", async () => {
            const seen: number[] = [];
            const search = createDebouncedSearch(async () => {
                throw new Error("502");
            }, (_q, hits) => seen.push(hits.length));
            search.update("zebra");
            await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
            expect(seen).toEqual([ 0 ]);
        });
    });
});
