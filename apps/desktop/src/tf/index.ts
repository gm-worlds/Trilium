/**
 * Main process of Taskforce Notes (`TF_DESKTOP=1`): the connect flow, the device key, the
 * `taskforce-notes:` links, the stop notices and the updates. `main.ts` calls the hooks below;
 * without `TF_DESKTOP` each of them returns at once.
 *
 * Contract: `infra/notes/DESKTOP.md` in the Taskforce repository ("Connect flow", "Gateway",
 * "Desktop app").
 */
import type { TfConnectCheck, TfConnectMode, TfDesktopInfo, TfDesktopResult, TfReplaceProgress, TfStockTrilium } from "@triliumnext/commons";
import { app_info as appInfo, becca_loader, cls, getLog, options as optionService, setup as setupService, sql_init } from "@triliumnext/core";
import {
    enableTfDesktop, getTfDesktopOption, getTfDesktopStop, isTfDesktopConnected, setTfDesktopOption, setTfDesktopStop,
    type TfDesktopStop, tfDesktopNeedsConnect
} from "@triliumnext/core/src/tf/desktop.js";
import syncService from "@triliumnext/core/src/services/sync.js";
import dataDirs from "@triliumnext/server/src/services/data_dir.js";
import { execFile } from "child_process";
import electron from "electron";
import fs from "fs";
import os from "os";
import path from "path";

import windowService from "../services/window";
import { isSameServer, normalizeServerOrigin, parseConnectLink, type TfConnectLink } from "./connect_link";
import { assertTfDataDirInUse, TF_DESKTOP, TF_DESKTOP_BUILD, TF_URL_SCHEME } from "./flavour";
import { takePendingConnect, writeFreshStartMarker } from "./fresh_start";
import { isRedeemAnswer, TfGateway, TfGatewayError, type TfRedeemAnswer, type TfSeedOption } from "./gateway";
import { TF_DATA_DIR } from "./prelude";
import { copyStockTriliumDb, findStockTriliumDb, isStockTriliumRunning, removeTempCopy } from "./stock_trilium";
import { TfUpdater } from "./updater";

interface CheckedLink {
    link: TfConnectLink;
    mode: TfConnectMode;
    replaceAllowed: boolean;
}

let checked: CheckedLink | null = null;
let pendingLink: string | null = null;
/** A redeemed answer whose notebook was replaced: used by {@link startFresh} and after the restart. */
let pendingRedeemed: TfRedeemAnswer | null = null;
let busy = false;
let updater: TfUpdater | null = null;

/** The version string of this build (`TF_DESKTOP_VERSION`, else `<upstream>-tf.<build>`). */
export function tfAppVersion() {
    return process.env.TF_DESKTOP_VERSION || `${appInfo.appVersion}-tf.${TF_DESKTOP_BUILD}`;
}

/**
 * Called first in `main()`, before `ready`: checks the data folder, registers the scheme, the
 * `open-url` handler and the IPC handlers, and turns on the core side.
 */
export function initTfDesktopMain() {
    if (!TF_DESKTOP) {
        return;
    }
    if (!TF_DATA_DIR) {
        throw new Error("Taskforce Notes started without its data folder.");
    }
    assertTfDataDirInUse(dataDirs.TRILIUM_DATA_DIR, TF_DATA_DIR);

    enableTfDesktop({ onStop: onSyncStop });

    const pending = takePendingConnect(TF_DATA_DIR);
    pendingLink = pending.link ?? findLinkInArgs(process.argv);
    pendingRedeemed = isRedeemAnswer(pending.redeemed) ? pending.redeemed : null;
    if (electron.app.isPackaged) {
        electron.app.setAsDefaultProtocolClient(TF_URL_SCHEME);
    }
    electron.app.on("open-url", (event, url) => {
        if (!url.toLowerCase().startsWith(`${TF_URL_SCHEME}:`)) {
            return;
        }
        event.preventDefault();
        void receiveLink(url);
    });

    updater = new TfUpdater(
        electron.app.isPackaged && process.platform === "darwin" ? electron.autoUpdater : null,
        () => ({
            syncServerHost: optionService.getOptionOrNull("syncServerHost") ?? "",
            deviceToken: getTfDesktopOption("tfDeviceToken"),
            build: TF_DESKTOP_BUILD
        }),
        broadcastState,
        (message) => getLog().info(`Taskforce Notes: ${message}`)
    );

    registerIpcHandlers();
}

/**
 * Called at the top of `onReady()`. Opens the connect screen when this Mac has no device key (or
 * lost it), and answers `true` then, so upstream's own window choice is skipped. A connected Mac
 * goes on to the notes and starts the update checks.
 */
export async function tfDesktopOnReady(): Promise<boolean> {
    if (!TF_DESKTOP) {
        return false;
    }
    electron.app.on("activate", () => {
        // A connected Mac's dock click is upstream's (main.ts); this one covers the connect screen.
        if (electron.BrowserWindow.getAllWindows().length === 0 && (!sql_init.isDbInitialized() || tfDesktopNeedsConnect())) {
            void windowService.createSetupWindow();
        }
    });
    if (sql_init.isDbInitialized() && !tfDesktopNeedsConnect()) {
        updater?.start();
        return false;
    }
    if (pendingRedeemed && !sql_init.isDbInitialized()) {
        // After a fresh start for a replaced notebook: the code was already redeemed.
        const answer = pendingRedeemed;
        pendingRedeemed = null;
        await createDatabaseFromRedeem(answer);
    } else if (sql_init.isDbInitialized()) {
        await sql_init.dbReady;
    } else if (isTfDesktopConnected() && sql_init.schemaExists()) {
        // The first sync was interrupted: the connect screen shows its progress, and this resumes it.
        setupService.triggerSync();
        void openNotesAfterFirstSync();
    }
    await windowService.createSetupWindow();
    return true;
}

/** Called from `second-instance`: a link passed on the command line (Windows, Linux). */
export function handleTfSecondInstance(commandLine: string[]): boolean {
    if (!TF_DESKTOP) {
        return false;
    }
    const link = findLinkInArgs(commandLine);
    if (!link) {
        return false;
    }
    void receiveLink(link);
    return true;
}

/** A link from the scheme: handed to an open connect screen, or opens one. */
async function receiveLink(link: string) {
    pendingLink = link;
    if (!electron.app.isReady()) {
        return;
    }
    const setupWindow = windowService.getSetupWindow();
    if (setupWindow && !setupWindow.isDestroyed()) {
        setupWindow.webContents.send("tf-desktop-link", link);
        windowService.showAndFocusWindow(setupWindow);
        return;
    }
    await windowService.createSetupWindow();
}

function findLinkInArgs(args: string[]) {
    return args.find((arg) => arg.toLowerCase().startsWith(`${TF_URL_SCHEME}:`)) ?? null;
}

function onSyncStop(stop: TfDesktopStop | null) {
    getLog().info(`Taskforce Notes: sync ${stop ? `stopped (${stop})` : "resumed"}.`);
    if (stop === "sync_version") {
        updater?.check();
    }
    broadcastState();
}

export function getTfDesktopInfo(): TfDesktopInfo {
    const initialized = sql_init.isDbInitialized();
    return {
        connected: isTfDesktopConnected(),
        hasLocalNotes: initialized,
        notebookName: getTfDesktopOption("tfNotebookName"),
        userName: getTfDesktopOption("tfUserName"),
        serverOrigin: normalizeServerOrigin(optionService.getOptionOrNull("syncServerHost") ?? "") ?? "",
        lastSyncAt: getTfDesktopOption("tfLastSyncAt"),
        stop: getTfDesktopStop(),
        appVersion: tfAppVersion(),
        appBuild: TF_DESKTOP_BUILD,
        syncVersion: appInfo.syncVersion,
        update: updater?.getState() ?? { state: "off" },
        pendingLink
    };
}

function broadcastState() {
    let info: TfDesktopInfo;
    try {
        info = getTfDesktopInfo();
    } catch {
        return;
    }
    for (const win of electron.BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
            win.webContents.send("tf-desktop-state", info);
        }
    }
}

function gatewayFor(server: string) {
    return new TfGateway(server, (url, init) => electron.net.fetch(url, { ...init, bypassCustomProtocolHandlers: true }));
}

/** Reads the link, asks the notebook which build it needs and whether it may be replaced. */
export async function checkConnectLink(raw: string): Promise<TfConnectCheck> {
    checked = null;
    const link = parseConnectLink(typeof raw === "string" ? raw : "");
    if (!link) {
        return { ok: false, reason: "bad_link" };
    }
    let update;
    try {
        update = await gatewayFor(link.server).getUpdate({ pairCode: link.code });
    } catch (e) {
        return gatewayFailure(e);
    }
    if (update.engine.syncVersion !== appInfo.syncVersion) {
        return {
            ok: false,
            reason: "version_mismatch",
            downloadUrl: update.app?.url,
            downloadVersion: update.app?.version
        };
    }

    const initialized = sql_init.isDbInitialized();
    const localServer = optionService.getOptionOrNull("syncServerHost") ?? "";
    const mode: TfConnectMode = !initialized ? "new"
        : localServer && isSameServer(localServer, link.server) ? "reconnect"
            : "other_notebook";
    // Replacing the notebook makes it another document, which only an empty Mac can sync with.
    const replaceAllowed = update.replace && mode === "new";
    checked = { link, mode, replaceAllowed };
    if (pendingLink && parseConnectLink(pendingLink)?.code === link.code) {
        pendingLink = null;
    }
    return {
        ok: true,
        server: link.server,
        mode,
        replaceAllowed,
        stockTrilium: replaceAllowed ? await describeStockTrilium() : null,
        notebookName: typeof update.notebookName === "string" ? update.notebookName : undefined,
        userName: typeof update.userName === "string" ? update.userName : undefined
    };
}

async function describeStockTrilium(): Promise<TfStockTrilium> {
    const found = findStockTriliumDb();
    return { found: !!found, sizeBytes: found?.sizeBytes, running: found ? await isStockTriliumRunning() : false };
}

function gatewayFailure(e: unknown): TfConnectCheck & { ok: false } {
    if (e instanceof TfGatewayError) {
        if (e.status === 0) {
            return { ok: false, reason: "network", message: e.message };
        }
        if (e.code === "not_eligible") {
            return { ok: false, reason: "not_eligible" };
        }
        if (e.status === 401 || e.status === 404 || e.status === 410) {
            return { ok: false, reason: "code_refused" };
        }
        return { ok: false, reason: "server", message: e.message };
    }
    return { ok: false, reason: "server", message: e instanceof Error ? e.message : String(e) };
}

/** Copies the stock Trilium's notes and sends them to the notebook, for the checked link. */
export async function bringStockNotes(onProgress: (progress: TfReplaceProgress) => void): Promise<TfDesktopResult<{ notes: number }>> {
    if (!checked?.replaceAllowed) {
        return { ok: false, message: "replace_not_allowed" };
    }
    if (busy) {
        return { ok: false, message: "busy" };
    }
    const found = findStockTriliumDb();
    if (!found) {
        return { ok: false, message: "no_stock_trilium" };
    }
    if (await isStockTriliumRunning()) {
        return { ok: false, message: "stock_trilium_running" };
    }

    busy = true;
    const { link } = checked;
    const tempPath = path.join(dataDirs.TMP_DIR, `tf-replace-${process.pid}-${Date.now()}.db`);
    try {
        const copy = await copyStockTriliumDb(found.path, tempPath, (done, total) => onProgress({ phase: "copying", done, total }));
        if (await isStockTriliumRunning()) {
            return { ok: false, message: "stock_trilium_running" };
        }
        const handle = await fs.promises.open(tempPath, "r");
        try {
            const parts = Math.max(1, Math.ceil(copy.sizeBytes / (64 * 1024 * 1024)));
            const result = await gatewayFor(link.server).replace(link.code, copy.sizeBytes, async (part, start, length) => {
                const buffer = Buffer.alloc(length);
                await handle.read(buffer, 0, length, start);
                onProgress(part === parts
                    ? { phase: "importing", done: start, total: copy.sizeBytes }
                    : { phase: "sending", done: start, total: copy.sizeBytes });
                return buffer;
            }, (sent) => onProgress({ phase: sent >= copy.sizeBytes ? "importing" : "sending", done: sent, total: copy.sizeBytes }));
            getLog().info(`Taskforce Notes: the notebook now holds the ${result.notes} notes from the Trilium app on this Mac.`);
            return { ok: true, notes: result.notes };
        } finally {
            await handle.close();
        }
    } catch (e) {
        getLog().error(`Taskforce Notes: bringing the Trilium notes failed: ${e instanceof Error ? e.stack : String(e)}`);
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
    } finally {
        removeTempCopy(tempPath);
        busy = false;
    }
}

/** Uses the checked link: redeems the code, stores the device key and starts the sync. */
export async function connectWithCheckedLink(): Promise<TfDesktopResult> {
    if (!checked) {
        return { ok: false, message: "no_link" };
    }
    if (checked.mode === "other_notebook") {
        return { ok: false, message: "other_notebook" };
    }
    if (busy) {
        return { ok: false, message: "busy" };
    }
    busy = true;
    const { link, mode } = checked;
    try {
        const answer = await gatewayFor(link.server).redeem({
            code: link.code,
            deviceName: await getDeviceName(),
            appVersion: tfAppVersion(),
            appBuild: TF_DESKTOP_BUILD,
            syncVersion: appInfo.syncVersion
        });
        checked = null;
        const host = normalizeServerOrigin(answer.syncServerHost);
        if (!host) {
            return { ok: false, message: "bad_sync_host" };
        }
        if (answer.syncVersion !== appInfo.syncVersion) {
            return { ok: false, message: "version_mismatch" };
        }
        const seed = pickSeed(answer.seed);

        if (mode === "new") {
            if (sql_init.isDbInitialized()) {
                return { ok: false, message: "already_initialized" };
            }
            await createDatabaseFromRedeem(answer);
        } else {
            const localDocumentId = optionService.getOptionOrNull("documentId");
            const seedDocumentId = seed.find((option) => option.name === "documentId")?.value;
            if (localDocumentId !== seedDocumentId) {
                // The notebook was replaced since this Mac last synced: its notes are another
                // document. The code is used up, so the answer is kept for startFresh().
                pendingRedeemed = answer;
                return { ok: false, message: "notebook_replaced" };
            }
            cls.init(() => {
                storeDevice(answer);
                optionService.setOption("syncServerHost", host);
            });
            setTfDesktopStop(null);
            void cls.init(() => syncService.sync());
            await windowService.createMainWindow();
            windowService.closeSetupWindow();
        }
        pendingLink = null;
        updater?.start();
        broadcastState();
        return { ok: true };
    } catch (e) {
        if (e instanceof TfGatewayError) {
            const failure = gatewayFailure(e);
            return { ok: false, message: failure.reason };
        }
        getLog().error(`Taskforce Notes: connecting failed: ${e instanceof Error ? e.stack : String(e)}`);
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
    } finally {
        busy = false;
    }
}

/** Creates the database for sync from a redeemed answer and starts the first sync. */
async function createDatabaseFromRedeem(answer: TfRedeemAnswer) {
    const host = normalizeServerOrigin(answer.syncServerHost);
    if (!host) {
        throw new Error("The notebook answered an address this app does not accept.");
    }
    await cls.init(async () => {
        await sql_init.createDatabaseForSync(pickSeed(answer.seed), host, "");
        storeDevice(answer);
    });
    setTfDesktopStop(null);
    setupService.triggerSync();
    void openNotesAfterFirstSync();
}

/**
 * Swaps the connect screen for the notes once the first sync has initialized the database and
 * becca has loaded. Upstream's own swap (`DB_INITIALIZED` in `window.ts`) runs before the startup
 * options exist and fails on `spellCheckEnabled`, so this one waits for `beccaLoaded`.
 */
async function openNotesAfterFirstSync() {
    await sql_init.dbReady;
    await becca_loader.beccaLoaded;
    try {
        if (!windowService.getMainWindow()) {
            await windowService.createMainWindow();
        }
        windowService.closeSetupWindow();
    } catch (e) {
        getLog().error(`Taskforce Notes: opening the notes failed: ${e instanceof Error ? e.stack : String(e)}`);
    }
    updater?.start();
    broadcastState();
}

/** The document options of the seed and nothing else, whatever else the answer carried. */
export function pickSeed(seed: TfSeedOption[]) {
    return seed
        .filter((option) => option.name === "documentId" || option.name === "documentSecret")
        .map((option) => ({ name: option.name, value: option.value, isSynced: true }));
}

function storeDevice(answer: TfRedeemAnswer) {
    setTfDesktopOption("tfDeviceToken", answer.deviceToken);
    setTfDesktopOption("tfDeviceId", answer.deviceId);
    setTfDesktopOption("tfNotebookName", answer.notebookName ?? "");
    setTfDesktopOption("tfUserName", answer.userName ?? "");
    setTfDesktopOption("tfLastSyncAt", "");
}

/** Forgets the device key; the notes stay. The next start shows the connect screen. */
export function disconnectThisMac() {
    cls.init(() => {
        setTfDesktopOption("tfDeviceToken", "");
        setTfDesktopOption("tfDeviceId", "");
    });
    setTfDesktopStop(null);
    updater?.stop();
    broadcastState();
    getLog().info("Taskforce Notes: this Mac was disconnected; the notes stay here.");
}

/**
 * Keeps the notes on this Mac as a backup file and restarts the app empty, which then continues
 * with the checked link of another notebook, or with the answer of a replaced notebook.
 */
async function startFresh(): Promise<TfDesktopResult> {
    if (!TF_DATA_DIR) {
        return { ok: false, message: "no_link" };
    }
    if (pendingRedeemed) {
        writeFreshStartMarker(TF_DATA_DIR, { redeemed: pendingRedeemed }, getTfDesktopOption("tfNotebookName"));
    } else if (checked?.mode === "other_notebook") {
        const link = `${TF_URL_SCHEME}://connect?server=${encodeURIComponent(checked.link.server)}&code=${checked.link.code}`;
        writeFreshStartMarker(TF_DATA_DIR, { link }, getTfDesktopOption("tfNotebookName"));
    } else {
        return { ok: false, message: "no_link" };
    }
    electron.app.relaunch();
    electron.app.exit(0);
    return { ok: true };
}

async function getDeviceName() {
    const fallback = os.hostname().replace(/\.local$/i, "");
    if (process.platform !== "darwin") {
        return fallback.slice(0, 80);
    }
    const name = await new Promise<string>((resolve) => {
        execFile("scutil", [ "--get", "ComputerName" ], { timeout: 3000 }, (error, stdout) => resolve(error ? "" : stdout.trim()));
    });
    return (name || fallback).slice(0, 80);
}

function registerIpcHandlers() {
    const { ipcMain } = electron;
    const handle = <T>(channel: string, fn: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<T> | T, onError: (message: string) => T) => {
        ipcMain.handle(channel, async (event, ...args) => {
            try {
                return await fn(event, ...args);
            } catch (e) {
                getLog().error(`${channel} failed: ${e instanceof Error ? e.stack : String(e)}`);
                return onError(e instanceof Error ? e.message : String(e));
            }
        });
    };
    const fail = (message: string) => ({ ok: false as const, message });

    handle("tf-desktop-get-info", () => getTfDesktopInfo(), () => { throw new Error("tf-desktop-get-info failed"); });
    handle("tf-desktop-check-link", (_event, link) => checkConnectLink(String(link ?? "")), (message) => ({ ok: false, reason: "server", message }) as TfConnectCheck);
    handle("tf-desktop-check-stock", () => (checked?.replaceAllowed ? describeStockTrilium() : null), () => null);
    handle("tf-desktop-bring-stock", (event) => bringStockNotes((progress) => {
        if (!event.sender.isDestroyed()) {
            event.sender.send("tf-desktop-replace-progress", progress);
        }
    }), fail);
    handle("tf-desktop-connect", () => connectWithCheckedLink(), fail);
    handle("tf-desktop-start-fresh", () => startFresh(), fail);
    handle("tf-desktop-disconnect", () => disconnectThisMac(), () => undefined);

    ipcMain.on("tf-desktop-open-offline", () => {
        try {
            if (sql_init.isDbInitialized()) {
                void windowService.createMainWindow().then(() => windowService.closeSetupWindow());
            }
        } catch (e) {
            getLog().error(`tf-desktop-open-offline failed: ${String(e)}`);
        }
    });
    ipcMain.on("tf-desktop-show-connect", () => {
        try {
            const setupWindow = windowService.getSetupWindow();
            if (setupWindow && !setupWindow.isDestroyed()) {
                windowService.showAndFocusWindow(setupWindow);
            } else {
                void windowService.createSetupWindow();
            }
        } catch (e) {
            getLog().error(`tf-desktop-show-connect failed: ${String(e)}`);
        }
    });
    ipcMain.on("tf-desktop-restart-to-update", () => {
        try {
            updater?.restartToUpdate();
        } catch (e) {
            getLog().error(`tf-desktop-restart-to-update failed: ${String(e)}`);
        }
    });
}
