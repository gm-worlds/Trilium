/**
 * The notes of a stock Trilium on this Mac, for "Bring along the notes from the Trilium app on this
 * Mac". The stock database is only ever opened read-only and copied with SQLite's online backup
 * API into a temporary file; the stock app's files are never written, moved or removed.
 */
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Where the stock app keeps its notes, the way its own `data_dir.ts` decides: `~/trilium-data`
 * when that folder exists, else `trilium-data` in the platform's app data folder.
 * `TF_TEST_STOCK_TRILIUM_DIR` replaces both, for tests that bring their own throwaway database.
 */
export function stockTriliumDbPath(env: { homedir: string; platform: NodeJS.Platform; appData?: string; testDir?: string; homeDataDirExists: boolean }) {
    if (env.testDir) {
        return path.join(env.testDir, "document.db");
    }
    if (env.homeDataDirExists) {
        return path.join(env.homedir, "trilium-data", "document.db");
    }
    switch (env.platform) {
        case "darwin": return path.join(env.homedir, "Library", "Application Support", "trilium-data", "document.db");
        case "win32": return env.appData ? path.join(env.appData, "trilium-data", "document.db") : null;
        case "linux": return path.join(env.homedir, ".local", "share", "trilium-data", "document.db");
        default: return null;
    }
}

/** The stock database on this machine, or `null`. Only `stat` is used: nothing is opened here. */
export function findStockTriliumDb(): { path: string; sizeBytes: number } | null {
    const dbPath = stockTriliumDbPath({
        homedir: os.homedir(),
        platform: process.platform,
        appData: process.env.APPDATA,
        testDir: process.env.TF_TEST_STOCK_TRILIUM_DIR || undefined,
        homeDataDirExists: fs.existsSync(path.join(os.homedir(), "trilium-data"))
    });
    if (!dbPath) {
        return null;
    }
    try {
        const stat = fs.statSync(dbPath);
        return stat.isFile() && stat.size > 0 ? { path: dbPath, sizeBytes: stat.size } : null;
    } catch {
        return null;
    }
}

/**
 * Whether a stock Trilium process is running, from `ps` output (`<pid> <command path>` lines).
 * Matches the macOS app bundle and the Linux and Windows executable, never this process.
 */
export function isStockTriliumInPsOutput(psOutput: string, ownPid: number, ownExecPath: string) {
    for (const line of psOutput.split("\n")) {
        const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
        if (!match) {
            continue;
        }
        const pid = Number(match[1]);
        const command = match[2];
        if (pid === ownPid || command === ownExecPath) {
            continue;
        }
        if (/\/Trilium Notes\.app\/Contents\//i.test(command)) {
            return true;
        }
        if (/(^|\/)(trilium|trilium\.exe)$/i.test(command)) {
            return true;
        }
    }
    return false;
}

export function isStockTriliumRunning(): Promise<boolean> {
    if (process.env.TF_TEST_STOCK_TRILIUM_RUNNING) {
        return Promise.resolve(process.env.TF_TEST_STOCK_TRILIUM_RUNNING === "1");
    }
    return new Promise((resolve) => {
        execFile("ps", [ "-axo", "pid=,comm=" ], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
            resolve(!error && isStockTriliumInPsOutput(stdout, process.pid, process.execPath));
        });
    });
}

/**
 * Copies the stock database into `targetPath`.
 *
 * SQLite cannot open a WAL database read-only without creating `-shm` and `-wal` files beside it,
 * which would write into the stock app's folder. So the files are first copied byte for byte
 * (reads only) into a private staging copy, a pending `-wal` included, and SQLite's online backup
 * API then writes `targetPath` from that copy: one self-contained file with the WAL applied, in
 * rollback-journal mode. The copy is checked and the staging files removed. Answers the number of
 * notes in the copy. The stock app must not run meanwhile (the caller asks the person to quit it).
 */
export async function copyStockTriliumDb(sourcePath: string, targetPath: string,
    onProgress: (done: number, total: number) => void): Promise<{ notes: number; sizeBytes: number }> {
    const mod = await import("better-sqlite3");
    const Database = (mod.default ?? mod) as unknown as typeof import("better-sqlite3");
    const staging = `${targetPath}.staging`;
    removeTempCopy(staging);
    try {
        await fs.promises.copyFile(sourcePath, staging, fs.constants.COPYFILE_EXCL);
        if (fs.existsSync(`${sourcePath}-wal`)) {
            await fs.promises.copyFile(`${sourcePath}-wal`, `${staging}-wal`, fs.constants.COPYFILE_EXCL);
        }

        const source = new Database(staging, { fileMustExist: true });
        try {
            await source.backup(targetPath, {
                progress({ totalPages, remainingPages }) {
                    onProgress(totalPages - remainingPages, totalPages);
                    return 256;
                }
            });
        } finally {
            source.close();
        }
    } finally {
        removeTempCopy(staging);
    }

    const copy = new Database(targetPath, { fileMustExist: true });
    try {
        copy.pragma("journal_mode = DELETE");
        const check = copy.pragma("quick_check", { simple: true });
        if (check !== "ok") {
            throw new Error(`The copy of the Trilium notes failed its check: ${String(check)}`);
        }
        const notes = copy.prepare("SELECT COUNT(*) FROM notes WHERE isDeleted = 0").pluck().get() as number;
        return { notes, sizeBytes: fs.statSync(targetPath).size };
    } finally {
        copy.close();
    }
}

/** Removes a temporary copy and the journal files SQLite may have left beside it. */
export function removeTempCopy(targetPath: string) {
    for (const suffix of [ "", "-wal", "-shm", "-journal" ]) {
        fs.rmSync(targetPath + suffix, { force: true });
    }
}
