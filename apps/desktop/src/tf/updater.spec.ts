import { describe, expect, it, vi } from "vitest";

import { squirrelFeed, TfUpdater, type AutoUpdaterLike } from "./updater";

function fakeUpdater() {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const updater = {
        setFeedURL: vi.fn(),
        checkForUpdates: vi.fn(),
        quitAndInstall: vi.fn(),
        on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener)
    } satisfies AutoUpdaterLike;
    return { updater, emit: (event: string, ...args: unknown[]) => listeners.get(event)?.(...args) };
}

describe("Taskforce Notes updates", () => {
    it("asks the notebook's own feed with the device key and the build number", () => {
        expect(squirrelFeed({ syncServerHost: "https://nb-example.invalid/", deviceToken: "tok", build: 12 })).toEqual({
            url: "https://nb-example.invalid/__tf/desktop/squirrel?build=12",
            headers: { "x-tf-device": "tok" },
            serverType: "json"
        });
        expect(squirrelFeed({ syncServerHost: "https://nb-example.invalid", deviceToken: "", build: 12 })).toBeNull();
        expect(squirrelFeed({ syncServerHost: "https://nb-example.invalid", deviceToken: "tok", build: 0 })).toBeNull();
    });

    it("checks, follows the download and offers the restart", () => {
        const { updater, emit } = fakeUpdater();
        let token = "tok1";
        const onChange = vi.fn();
        const tf = new TfUpdater(updater, () => ({ syncServerHost: "https://nb-example.invalid", deviceToken: token, build: 3 }), onChange, () => {});
        tf.start();
        expect(updater.setFeedURL).toHaveBeenCalledWith(expect.objectContaining({ headers: { "x-tf-device": "tok1" } }));
        expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);

        token = "tok2";
        tf.check();
        expect(updater.setFeedURL).toHaveBeenLastCalledWith(expect.objectContaining({ headers: { "x-tf-device": "tok2" } }));

        emit("update-available");
        expect(tf.getState().state).toBe("downloading");
        tf.check();
        expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
        emit("update-downloaded", {}, "notes", "0.107.0-tf.4");
        expect(tf.getState()).toEqual({ state: "ready", version: "0.107.0-tf.4" });
        tf.restartToUpdate();
        expect(updater.quitAndInstall).toHaveBeenCalledOnce();
        expect(onChange).toHaveBeenCalled();
        tf.stop();
    });

    it("does nothing in a build that cannot update itself", () => {
        const tf = new TfUpdater(null, () => ({ syncServerHost: "x", deviceToken: "t", build: 1 }), () => {}, () => {});
        tf.start();
        expect(tf.getState().state).toBe("off");
    });
});
