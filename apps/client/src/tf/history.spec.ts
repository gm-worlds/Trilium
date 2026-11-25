import { afterEach, describe, expect, it, vi } from "vitest";

import { getTfHistoryEntries, getTfHistoryState, installTfHistory, uninstallTfHistory } from "./history.js";

describe("tf history", () => {
    afterEach(() => {
        uninstallTfHistory();
        window.history.replaceState(null, "", "/");
    });

    it("keeps note navigation out of the browser history and steps through its own list", () => {
        window.history.replaceState(null, "", "/#root/a");
        const length = window.history.length;
        installTfHistory();
        window.history.pushState(null, "", "#root/b");
        window.history.pushState(null, "", "#root/c");
        expect(window.history.length).toBe(length);
        expect(window.location.hash).toBe("#root/c");
        expect(getTfHistoryState().entries.map((url) => new URL(url).hash)).toEqual([ "#root/a", "#root/b", "#root/c" ]);

        const hashes: string[] = [];
        const onHash = vi.fn(() => hashes.push(window.location.hash));
        window.addEventListener("hashchange", onHash);
        window.history.back();
        window.history.back();
        window.history.back();
        window.history.forward();
        window.removeEventListener("hashchange", onHash);
        expect(hashes).toEqual([ "#root/b", "#root/a", "#root/b" ]);

        expect(getTfHistoryEntries("back")?.map((e) => new URL(e.url).hash)).toEqual([ "#root/a" ]);
        expect(getTfHistoryEntries("forward")?.map((e) => new URL(e.url).hash)).toEqual([ "#root/c" ]);

        window.history.pushState(null, "", "#root/d");
        expect(getTfHistoryEntries("forward")).toEqual([]);
        window.history.replaceState(null, "", "#root/e");
        expect(getTfHistoryState()).toMatchObject({ index: 2 });
        expect(new URL(getTfHistoryState().entries[2]).hash).toBe("#root/e");
    });

    it("gives the browser its own methods back", () => {
        const pushState = window.history.pushState;
        installTfHistory();
        expect(window.history.pushState).not.toBe(pushState);
        uninstallTfHistory();
        expect(window.history.pushState).toBe(pushState);
        expect(getTfHistoryEntries("back")).toBeNull();
    });
});
