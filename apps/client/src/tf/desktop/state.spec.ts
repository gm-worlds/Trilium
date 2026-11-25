import type { TfDesktopInfo } from "@triliumnext/commons";
import { afterEach, describe, expect, it } from "vitest";

import { describeFailure, screenForCheck } from "./connect";
import { formatSyncTime, getTfDesktopApi, isTfDesktopClient, noticeFor, tt } from "./state";
import { TF_DESKTOP_STRINGS_EN, TF_DESKTOP_STRINGS_NL } from "./strings";
import { statusText } from "./sync_options";

const info = (patch: Partial<TfDesktopInfo> = {}): TfDesktopInfo => ({
    connected: true, hasLocalNotes: true, notebookName: "Notes", userName: "Person", serverOrigin: "https://nb-example.invalid",
    lastSyncAt: "", stop: null, appVersion: "0.107.0-tf.1", appBuild: 1, syncVersion: 41, update: { state: "idle" }, pendingLink: null,
    ...patch
});

describe("Taskforce Notes client", () => {
    const previous = window.glob;
    afterEach(() => {
        window.glob = previous;
    });

    it("is inert outside Taskforce Notes", () => {
        window.glob = { ...previous } as typeof window.glob;
        expect(isTfDesktopClient()).toBe(false);
        expect(getTfDesktopApi()).toBeNull();
        window.glob = { ...previous, tfDesktop: { needsConnect: false } } as typeof window.glob;
        expect(isTfDesktopClient()).toBe(true);
    });

    it("shows the disconnected notice first, then the update", () => {
        expect(noticeFor(null)).toBeNull();
        expect(noticeFor(info())).toBeNull();
        expect(noticeFor(info({ stop: "device_revoked", update: { state: "ready" } }))).toBe("revoked");
        expect(noticeFor(info({ stop: "not_eligible" }))).toBe("not_eligible");
        expect(noticeFor(info({ stop: "sync_version" }))).toBe("update_on_its_way");
        expect(noticeFor(info({ stop: "sync_version", update: { state: "ready" } }))).toBe("update_ready");
        expect(tt("revoked_notice")).toContain("This Mac was disconnected from Taskforce");
    });

    it("describes the connection on the Settings page", () => {
        expect(statusText(info())).toBe(tt("status_syncing"));
        expect(statusText(info({ connected: false }))).toBe(tt("status_disconnected"));
        expect(statusText(info({ stop: "device_revoked" }))).toBe(tt("status_revoked"));
        expect(formatSyncTime("2026-11-25 10:00:00.000Z", "en-GB")).toMatch(/25 Nov 2026/);
        expect(formatSyncTime("", "en-GB")).toBe("");
    });

    it("picks the connect screen for each answer of the notebook", () => {
        expect(screenForCheck({ ok: false, reason: "version_mismatch", downloadUrl: "https://nb-example.invalid/d", downloadVersion: "1" }))
            .toEqual({ kind: "version", downloadUrl: "https://nb-example.invalid/d", downloadVersion: "1" });
        expect(screenForCheck({ ok: false, reason: "code_refused" })).toEqual({ kind: "link", error: tt("code_refused") });
        const ok = { ok: true as const, server: "https://nb-example.invalid", mode: "new" as const, replaceAllowed: false, stockTrilium: null };
        expect(screenForCheck(ok)).toEqual({ kind: "ready", check: ok });
        expect(screenForCheck({ ...ok, replaceAllowed: true, stockTrilium: { found: true, running: false, sizeBytes: 5 } }).kind).toBe("bring");
        expect(screenForCheck({ ...ok, mode: "other_notebook" })).toEqual({ kind: "other" });
        expect(screenForCheck({ ok: false, reason: "server", message: "500 https://nb-example.invalid/x" }))
            .toEqual({ kind: "link", error: tt("server_error") });
    });

    it("never shows a raw error, address or file path", () => {
        expect(describeFailure("network")).toBe(tt("network"));
        expect(describeFailure("stock_trilium_running", "bring_failed")).toBe(tt("bring_running"));
        expect(describeFailure("ENOENT: no such file, open '/home/example/trilium-data/document.db'")).toBe(tt("connect_failed"));
        expect(describeFailure("Request to https://nb-example.invalid/__tf/desktop/replace failed", "bring_failed")).toBe(tt("bring_failed"));
        for (const text of [ ...Object.values(TF_DESKTOP_STRINGS_EN), ...Object.values(TF_DESKTOP_STRINGS_NL) ]) {
            expect(text.replaceAll(/\{\{\w+\}\}/g, "")).not.toMatch(/https?:|:\/\/|[/()[\]{}<>—]/);
        }
    });
});
