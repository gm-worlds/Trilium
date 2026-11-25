import { afterEach, describe, expect, it, vi } from "vitest";

/** Loads `editor_host.ts` (and `state.ts`) fresh, as a page with these glob flags inside a frame. */
async function loadInFrame(glob: Record<string, unknown>) {
    vi.resetModules();
    Object.defineProperty(window, "parent", { value: {}, configurable: true });
    window.glob = { ...window.glob, ...glob } as typeof window.glob;
    const pushState = window.history.pushState;
    const host = await import("./editor_host.js");
    const history = await import("../history.js");
    return { host, history, historyPatched: window.history.pushState !== pushState };
}

async function settlesAtOnce(promise: Promise<void>) {
    const tick = new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 20));
    return await Promise.race([ promise.then(() => "ready" as const), tick ]);
}

describe("tf editor host outside an embedding", () => {
    const originalParent = Object.getOwnPropertyDescriptor(window, "parent");
    const originalGlob = window.glob;

    afterEach(() => {
        if (originalParent) {
            Object.defineProperty(window, "parent", originalParent);
        }
        window.glob = originalGlob;
    });

    it("neither waits nor patches history in a frame of an engine without TF_EMBED", async () => {
        const { host, history, historyPatched } = await loadInFrame({ tfEmbed: false });
        expect(historyPatched).toBe(false);
        expect(await settlesAtOnce(host.whenTfEditorReady())).toBe("ready");
        history.uninstallTfHistory();
    });

    it("waits for the bootstrap and keeps history in the frame when the engine is embedded", async () => {
        const { host, history, historyPatched } = await loadInFrame({ tfEmbed: true });
        expect(historyPatched).toBe(true);
        const ready = host.whenTfEditorReady();
        expect(await settlesAtOnce(ready)).toBe("waiting");
        host.settleTfWork(null);
        expect(await settlesAtOnce(ready)).toBe("ready");
        history.uninstallTfHistory();
    });
});
