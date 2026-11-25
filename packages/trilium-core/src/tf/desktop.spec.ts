import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import becca from "../becca/becca.js";
import contentHashService from "../services/content_hash.js";
import * as cls from "../services/context.js";
import options from "../services/options.js";
import { type ExecOpts, initRequest, type RequestProvider } from "../services/request.js";
import { getSql } from "../services/sql/index.js";
import syncService from "../services/sync.js";
import syncOptions from "../services/sync_options.js";
import syncUpdateService from "../services/sync_update.js";
import { fakeRequestProvider } from "../test/request_provider.js";
import {
    classifyTfSyncError, disableTfDesktop, enableTfDesktop, getTfDesktopOption, getTfDesktopStop, getTfSyncHeaders,
    isTfDesktopSyncBlocked, setTfDesktopOption, setTfDesktopStop, type TfDesktopStop, tfDesktopNeedsConnect
} from "./desktop.js";

const requests: ExecOpts[] = [];
let failWith: Error | null = null;

const fakeRequest: RequestProvider = fakeRequestProvider({
    exec: (<T,>(opts: ExecOpts): Promise<T> => {
        requests.push(opts);
        if (failWith) {
            return Promise.reject(failWith);
        }
        const reply = (value: unknown) => Promise.resolve(value as T);
        if (opts.url.includes("/api/login/sync")) return reply({ instanceId: "ENGINE", maxEntityChangeId: 0 });
        if (opts.url.includes("/api/sync/changed")) return reply({ entityChanges: [], lastEntityChangeId: 0, outstandingPullCount: 0 });
        if (opts.url.includes("/api/sync/check")) return reply({ maxEntityChangeId: 0, entityHashes: {} });
        return reply({});
    }) as RequestProvider["exec"]
});

const runSync = () => cls.init(() => syncService.sync());
const inContext = <T,>(fn: () => T) => cls.init(fn);

describe("tf desktop core", () => {
    const stops: (TfDesktopStop | null)[] = [];
    let previousHost: string | null = null;

    beforeEach(() => {
        initRequest(fakeRequest);
        requests.length = 0;
        failWith = null;
        stops.length = 0;
        enableTfDesktop({ onStop: (stop) => stops.push(stop) });
        vi.spyOn(syncOptions, "getSyncServerHost").mockReturnValue("https://nb-example.invalid");
        vi.spyOn(syncOptions, "getSyncProxy").mockReturnValue("");
        vi.spyOn(syncOptions, "getSyncTimeout").mockReturnValue(2000);
        vi.spyOn(contentHashService, "checkContentHashes").mockReturnValue([]);
        previousHost = options.getOptionOrNull("syncServerHost");
        inContext(() => {
            options.setOption("syncServerHost", "https://nb-example.invalid");
            setTfDesktopOption("tfDeviceToken", "dev_token_1");
            setTfDesktopOption("tfDeviceId", "dev1");
        });
    });

    afterEach(() => {
        inContext(() => {
            setTfDesktopOption("tfDeviceToken", "");
            options.setOption("syncServerHost", previousHost ?? "");
        });
        disableTfDesktop();
        vi.restoreAllMocks();
    });

    it("reads the gateway's device errors and Trilium's sync version refusal", () => {
        expect(classifyTfSyncError("Request to POST https://nb-example.invalid/api/login/sync failed, error: 401 Unauthorized device_revoked")).toBe("device_revoked");
        expect(classifyTfSyncError("Request to GET x failed, error: 403 Forbidden not_eligible")).toBe("not_eligible");
        expect(classifyTfSyncError("Request to POST x failed, error: 400 Bad Request Non-matching sync versions, local is version 41, remote is 40.")).toBe("sync_version");
        expect(classifyTfSyncError("Request to POST x failed, error: 401 Unauthorized Logged in session not found")).toBeNull();
        expect(classifyTfSyncError("Request to POST x failed, error: 429 Too Many Requests ")).toBeNull();
        expect(classifyTfSyncError("No connection to sync server: connect ECONNREFUSED")).toBeNull();
    });

    it("sends x-tf-device with every sync request and skips the setup status route", async () => {
        await expect(runSync()).resolves.toEqual({ success: true });

        expect(requests.length).toBeGreaterThan(3);
        for (const request of requests) {
            expect(request.headers).toEqual({ "x-tf-device": "dev_token_1" });
        }
        expect(requests.some((r) => r.url.includes("/api/setup/"))).toBe(false);
        expect(getTfDesktopOption("tfLastSyncAt")).toMatch(/^\d{4}-\d\d-\d\d /);
    });

    it("keeps the device options local: not synced, never pushed, never pulled", async () => {
        const row = getSql().getRow<{ isSynced: number }>("SELECT isSynced FROM options WHERE name = 'tfDeviceToken'");
        expect(row?.isSynced).toBe(0);
        const change = getSql().getRow<{ isSynced: number }>(
            "SELECT isSynced FROM entity_changes WHERE entityName = 'options' AND entityId = 'tfDeviceToken'");
        expect(change?.isSynced).toBe(0);

        // A row that arrived synced is turned local on the next write.
        inContext(() => {
            getSql().execute("UPDATE options SET isSynced = 1 WHERE name = 'tfDeviceId'");
            const cached = becca.getOption("tfDeviceId");
            if (cached) cached.isSynced = true;
            setTfDesktopOption("tfDeviceId", "dev2");
        });
        expect(getSql().getValue("SELECT isSynced FROM options WHERE name = 'tfDeviceId'")).toBe(0);

        await runSync();
        const pushed = requests
            .filter((r) => r.url.includes("/api/sync/update"))
            .flatMap((r) => (typeof r.body === "string" ? JSON.parse(r.body || "{}").entities ?? [] : []))
            .map((record: { entityChange: { entityId: string } }) => record.entityChange.entityId);
        expect(pushed.filter((id: string) => id.startsWith("tf"))).toEqual([]);

        // A pulled change for the device key is refused.
        inContext(() => syncUpdateService.updateEntities([ {
            entityChange: {
                entityName: "options", entityId: "tfDeviceToken", hash: "x", isErased: false,
                utcDateChanged: "2100-01-01 00:00:00.000Z", isSynced: true, componentId: "c", changeId: "ch1", instanceId: "ENGINE"
            },
            entity: { name: "tfDeviceToken", value: "from_the_engine", isSynced: true, utcDateModified: "2100-01-01 00:00:00.000Z" }
        } ] as never, "ENGINE"));
        expect(getTfDesktopOption("tfDeviceToken")).toBe("dev_token_1");
    });

    it("stops the loop on a revoked device and asks to connect again", async () => {
        failWith = new Error("Request to POST https://nb-example.invalid/api/login/sync failed, error: 401 Unauthorized device_revoked");

        await expect(runSync()).resolves.toMatchObject({ success: false });

        expect(getTfDesktopStop()).toBe("device_revoked");
        expect(stops).toEqual([ "device_revoked" ]);
        expect(isTfDesktopSyncBlocked()).toBe(true);
        expect(syncOptions.isSyncSetup()).toBe(false);
        expect(tfDesktopNeedsConnect()).toBe(true);

        requests.length = 0;
        failWith = null;
        await expect(runSync()).resolves.toMatchObject({ success: false, errorCode: "NOT_CONFIGURED" });
        expect(requests).toEqual([]);

        // Connecting again clears the stop.
        setTfDesktopStop(null);
        await expect(runSync()).resolves.toEqual({ success: true });
        expect(stops).toEqual([ "device_revoked", null ]);
    });

    it("stops on another sync version without asking to connect again", async () => {
        failWith = new Error("Request to POST x failed, error: 400 Bad Request Non-matching sync versions, local is version 42, remote is 41.");
        await runSync();
        expect(getTfDesktopStop()).toBe("sync_version");
        expect(tfDesktopNeedsConnect()).toBe(false);
        setTfDesktopStop(null);
    });

    it("sends nothing without a device key, and nothing at all outside the desktop app", async () => {
        inContext(() => setTfDesktopOption("tfDeviceToken", ""));
        expect(getTfSyncHeaders()).toBeUndefined();
        expect(isTfDesktopSyncBlocked()).toBe(true);
        expect(tfDesktopNeedsConnect()).toBe(true);
        await expect(runSync()).resolves.toMatchObject({ errorCode: "NOT_CONFIGURED" });
        expect(requests).toEqual([]);

        disableTfDesktop();
        expect(getTfSyncHeaders()).toBeUndefined();
        expect(isTfDesktopSyncBlocked()).toBe(false);
        expect(tfDesktopNeedsConnect()).toBe(false);
    });
});
