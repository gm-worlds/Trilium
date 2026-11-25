/**
 * Core side of the Taskforce Notes desktop app (`TF_DESKTOP=1`): the fork's Electron build that
 * syncs with one Taskforce notebook through the notes gateway, with Trilium's own sync protocol.
 *
 * The gateway lets a sync request through only with the device key the app got when it was
 * connected (`x-tf-device`). That key and what came with it live in options that are never synced
 * ({@link TF_DESKTOP_OPTIONS}), so they stay on this Mac. The host (`apps/desktop/src/tf/`) turns
 * the mode on with {@link enableTfDesktop}; until then every hook in upstream code is a no-op.
 *
 * Nothing here reads the environment, so the module also loads in standalone's worker, where it
 * stays inert.
 */
import type { OptionNames } from "@triliumnext/commons";

import becca from "../becca/becca.js";
import BOption from "../becca/entities/boption.js";
import optionService from "../services/options.js";
import { getSql } from "../services/sql/index.js";
import dateUtils from "../services/utils/date.js";

/**
 * The options of a connected Mac. All are created with `isSynced = false`, so their entity changes
 * are never pushed and the engine never receives them.
 *
 * | Option | Meaning |
 * |---|---|
 * | `tfDeviceToken` | the device key, sent as `x-tf-device` with every sync request |
 * | `tfDeviceId` | the device's id in Taskforce |
 * | `tfNotebookName` | the notebook's name, for Settings and the connect screen |
 * | `tfUserName` | the person the notebook belongs to |
 * | `tfLastSyncAt` | when the last sync finished (UTC), written without an entity change |
 */
export const TF_DESKTOP_OPTIONS = [ "tfDeviceToken", "tfDeviceId", "tfNotebookName", "tfUserName", "tfLastSyncAt" ] as const;
export type TfDesktopOption = typeof TF_DESKTOP_OPTIONS[number];

/** Why syncing stopped for good (until the person acts): see {@link classifyTfSyncError}. */
export type TfDesktopStop = "device_revoked" | "not_eligible" | "sync_version";

export type TfDesktopStopListener = (stop: TfDesktopStop | null) => void;

let desktop = false;
let stop: TfDesktopStop | null = null;
let stopListener: TfDesktopStopListener | null = null;

/** Turns the desktop behaviour on. Called once by the desktop app's main process. */
export function enableTfDesktop(opts: { onStop?: TfDesktopStopListener } = {}) {
    desktop = true;
    stopListener = opts.onStop ?? null;
}

/** For tests: back to upstream behaviour. */
export function disableTfDesktop() {
    desktop = false;
    stop = null;
    stopListener = null;
}

export function isTfDesktop() {
    return desktop;
}

/** A Taskforce Notes option, or `""` when it is missing (or the database has no schema yet). */
export function getTfDesktopOption(name: TfDesktopOption): string {
    return optionService.getOptionOrNull(name as OptionNames) ?? "";
}

/**
 * Writes a Taskforce Notes option as a not-synced row. An existing row is kept not-synced even if
 * it somehow arrived as synced, so the value can never travel. Works before becca is loaded (right
 * after the database was created for sync), the way `createDatabaseForSync` writes the seed.
 */
export function setTfDesktopOption(name: TfDesktopOption, value: string) {
    const existing = becca.loaded ? becca.getOption(name) : null;
    if (existing) {
        existing.value = value;
        existing.isSynced = false;
        existing.save();
        return;
    }
    new BOption({ name, value, isSynced: false }).save();
}

/**
 * Whether a pulled entity change would write one of {@link TF_DESKTOP_OPTIONS}. They are never
 * synced from here, so one arriving from the engine is refused rather than overwriting the key.
 */
export function isTfDesktopOptionChange(ec: { entityName: string; entityId: string }) {
    return desktop && ec.entityName === "options" && (TF_DESKTOP_OPTIONS as readonly string[]).includes(ec.entityId);
}

/** Records the end of a successful sync without an entity change, as `setLastSyncedPush` does. */
export function noteTfSyncSuccess() {
    if (!desktop) {
        return;
    }
    if (stop) {
        setTfDesktopStop(null);
    }
    try {
        const now = dateUtils.utcNowDateTime();
        const sql = getSql();
        if (sql.getValue("SELECT 1 FROM options WHERE name = 'tfLastSyncAt'")) {
            sql.execute("UPDATE options SET value = ? WHERE name = 'tfLastSyncAt'", [ now ]);
            const cached = becca.loaded ? becca.getOption("tfLastSyncAt") : null;
            if (cached) {
                cached.value = now;
            }
        } else {
            setTfDesktopOption("tfLastSyncAt", now);
        }
    } catch {
        // The time is for display only.
    }
}

/** The headers every request to the sync server carries; `undefined` outside the desktop app. */
export function getTfSyncHeaders(): Record<string, string> | undefined {
    if (!desktop) {
        return undefined;
    }
    const token = getTfDesktopOption("tfDeviceToken");
    return token ? { "x-tf-device": token } : undefined;
}

/** Whether this Mac has a device key. */
export function isTfDesktopConnected() {
    return desktop && getTfDesktopOption("tfDeviceToken") !== "";
}

/**
 * Whether sync must not run: no device key (never connected, or disconnected), or a stop that
 * needs the person (revoked, no longer one person's notebook, another sync version).
 */
export function isTfDesktopSyncBlocked() {
    return desktop && (stop !== null || !isTfDesktopConnected());
}

/** Throws before a sync request leaves when {@link isTfDesktopSyncBlocked}. */
export function assertTfDesktopSyncAllowed() {
    if (!isTfDesktopSyncBlocked()) {
        return;
    }
    throw new Error(stop
        ? `Sync stopped: ${stop}.`
        : "This Mac is not connected to a Taskforce notebook.");
}

/** Whether the app shows the connect screen instead of the notes. */
export function tfDesktopNeedsConnect() {
    return desktop && (!isTfDesktopConnected() || stop === "device_revoked" || stop === "not_eligible");
}

/** The page bootstrap's `tfDesktop`: only in the desktop app, where the client reads it. */
export function getTfDesktopBootstrap(): { needsConnect: boolean } | undefined {
    return desktop ? { needsConnect: tfDesktopNeedsConnect() } : undefined;
}

export function getTfDesktopStop() {
    return stop;
}

export function setTfDesktopStop(value: TfDesktopStop | null) {
    if (stop === value) {
        return;
    }
    stop = value;
    stopListener?.(value);
}

/**
 * Reads a failed sync request for the answers that stop syncing until the person acts. The request
 * provider reports a failure as `<status> <status text> <message or error of the JSON body>`.
 *
 * - 401 `{ error: "device_revoked" }` from the gateway: the device was removed in Taskforce.
 * - 403 `{ error: "not_eligible" }` from the gateway: the notebook is no longer one person's.
 * - Trilium's own "Non-matching sync versions" (login) or the setup check's "sync protocol
 *   version": the engine runs another sync version, so this app needs its update.
 *
 * Anything else (no connection, 429, a 5xx) is passing, and the sync timer tries again.
 */
export function classifyTfSyncError(message: string): TfDesktopStop | null {
    if (/\b401\b[^\n]*\bdevice_revoked\b/.test(message)) {
        return "device_revoked";
    }
    if (/\b403\b[^\n]*\bnot_eligible\b/.test(message)) {
        return "not_eligible";
    }
    if (/Non-matching sync versions|local sync protocol version is/.test(message)) {
        return "sync_version";
    }
    return null;
}

/** Called from the sync loop's error handler; stops the loop on the answers above. */
export function noteTfSyncError(e: unknown) {
    if (!desktop) {
        return;
    }
    const message = e instanceof Error ? e.message : String(e);
    const kind = classifyTfSyncError(message);
    if (kind) {
        setTfDesktopStop(kind);
    }
}
