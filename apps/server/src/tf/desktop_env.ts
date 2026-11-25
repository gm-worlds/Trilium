/**
 * The data folder and port of Taskforce Notes (`TF_DESKTOP=1`), the fork's desktop build that
 * syncs with one Taskforce notebook. `data_dir.ts` calls {@link claimTfDesktopEnv} before it
 * resolves anything, so the folder is right whatever order the bundle evaluates its modules in.
 * Without `TF_DESKTOP` nothing here changes the environment.
 *
 * The build bakes `process.env.TF_DESKTOP` into the desktop bundle (`tfDesktopDefines()` in
 * `scripts/build-utils.ts`); in dev it is read from the environment.
 */
import os from "os";
import path from "path";

export const TF_PRODUCT_NAME = "Taskforce Notes";

/**
 * The port of the app's own local listener. Stock Trilium uses 37840 (37740 in dev); a different
 * one lets both apps run at the same time.
 */
export const TF_DEFAULT_PORT = "37851";

export function isTfDesktopBuild() {
    return process.env.TF_DESKTOP === "1";
}

/** Folder names Trilium itself uses for its data; Taskforce Notes never runs on one of them. */
const STOCK_DATA_DIR_NAMES = new Set([ "trilium-data", "trilium notes", "trilium" ]);

export function parseBuildNumber(value: string | undefined) {
    const build = Number.parseInt(value ?? "", 10);
    return Number.isInteger(build) && build > 0 ? build : 0;
}

export interface TfDataDirEnv {
    platform: NodeJS.Platform;
    homedir: string;
    /** `%APPDATA%` on Windows. */
    appData?: string;
    /** `TF_NOTES_DATA_DIR`: a data folder chosen for dev and tests. */
    override?: string;
}

/**
 * The data folder of Taskforce Notes: `~/Library/Application Support/Taskforce Notes` on macOS
 * (the Linux and Windows equivalents elsewhere), or `TF_NOTES_DATA_DIR` when set. Upstream's own
 * resolution (`TRILIUM_DATA_DIR`, then `~/trilium-data`, then `<app data>/trilium-data`) is never
 * consulted, so the stock app's notes cannot be opened by accident.
 */
export function resolveTfDataDir(env: TfDataDirEnv): string {
    let dir: string;
    if (env.override) {
        dir = path.resolve(env.override);
    } else if (env.platform === "darwin") {
        dir = path.join(env.homedir, "Library", "Application Support", TF_PRODUCT_NAME);
    } else if (env.platform === "win32") {
        dir = path.join(env.appData ?? path.join(env.homedir, "AppData", "Roaming"), TF_PRODUCT_NAME);
    } else {
        dir = path.join(env.homedir, ".local", "share", TF_PRODUCT_NAME);
    }
    assertNotStockDataDir(dir, env.homedir);
    return dir;
}

/** Throws when `dir` is, or lies inside, a folder Trilium itself keeps its data in. */
export function assertNotStockDataDir(dir: string, homedir: string) {
    const resolved = path.resolve(dir);
    const segments = resolved.split(/[\\/]+/).map((segment) => segment.toLowerCase());
    if (segments.some((segment) => STOCK_DATA_DIR_NAMES.has(segment))) {
        throw new Error(`Taskforce Notes refuses the data folder ${resolved}: it belongs to Trilium.`);
    }
    if (resolved === path.resolve(homedir)) {
        throw new Error("Taskforce Notes refuses the home folder as its data folder.");
    }
}

/** The data folder for this process, from the real environment. */
function getTfDataDir() {
    return resolveTfDataDir({
        platform: process.platform,
        homedir: os.homedir(),
        appData: process.env.APPDATA,
        override: process.env.TF_NOTES_DATA_DIR || undefined
    });
}

/**
 * Environment variables through which upstream lets a data folder or one of its files be put
 * elsewhere. In a Taskforce Notes build they are removed before the server code reads them.
 */
export const UPSTREAM_DATA_ENV = [
    "TRILIUM_DATA_DIR", "TRILIUM_DOCUMENT_PATH", "TRILIUM_BACKUP_DIR", "TRILIUM_LOG_DIR", "TRILIUM_TMP_DIR",
    "TRILIUM_ANONYMIZED_DB_DIR", "TRILIUM_CONFIG_INI_PATH", "TRILIUM_OCR_CACHE_DIR", "TRILIUM_RESOURCES_DIR",
    "TRILIUM_ELECTRON_DATA_DIR"
] as const;

/**
 * Rewrites `env` for a Taskforce Notes process: its own data folder, Chromium profile and port.
 * Returns the data folder.
 */
export function applyTfDesktopEnv(env: NodeJS.ProcessEnv, dataDir: string) {
    for (const name of UPSTREAM_DATA_ENV) {
        delete env[name];
    }
    env.TRILIUM_DATA_DIR = dataDir;
    env.TRILIUM_ELECTRON_DATA_DIR = path.join(dataDir, "electron-profile");
    env.TRILIUM_PORT = env.TF_NOTES_PORT || TF_DEFAULT_PORT;
    return dataDir;
}

let claimed: string | null = null;

/**
 * In a Taskforce Notes process: points the environment at the app's own data folder, Chromium
 * profile and port, and answers the folder. Idempotent; `null` outside Taskforce Notes.
 */
export function claimTfDesktopEnv(): string | null {
    if (!isTfDesktopBuild()) {
        return null;
    }
    if (!claimed) {
        claimed = applyTfDesktopEnv(process.env, getTfDataDir());
    }
    return claimed;
}
